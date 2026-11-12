import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { LibrarySource } from '../../../shared/types'
import type { PMNode } from '../../../shared/markdown'
import { citationDoc, type CitationMark } from '../../../shared/citations'
import { t } from '../../../shared/i18n'
import { dayLabel } from '../dates'
import { SourceCitationCard } from './SourceCitation'
import { InlineText } from './InlineText'

/** The shared streamed/saved Markdown answer. Word and citation keys stay stable as the answer grows. */
export function AnswerText({ md, live, sources, onSource }: {
  md: string; live: boolean; sources: LibrarySource[]
  onSource: (s: LibrarySource, match?: string) => void
}) {
  const id = useId(), [open, setOpen] = useState(false), [triggerId, setTriggerId] = useState<string | null>(null)
  const [animate, setAnimate] = useState(false)
  const suppressed = useRef<string | null>(null)
  const doc = useMemo(() => {
    const doc = citationDoc(md, sources, live)
    const prepare = (node: PMNode) => {
      // Base UI stores trigger payloads; their identity must survive popover state updates.
      if (node.type === 'citation') node.attrs!.payloads = (node.attrs!.marks as CitationMark[]).map(mark => ({ source: sources.find(s => s.n === mark.source)!, sentence: String(node.attrs!.sentence ?? '') }))
      node.content?.forEach(prepare)
    }
    prepare(doc)
    return doc
  }, [md, sources, live])
  const ctx: Ctx = { live, at: { n: 0 }, id, sources, focus: (element) => {
    if (!element.matches(':focus-visible')) return
    if (suppressed.current === element.id) { suppressed.current = null; return }
    setAnimate(false); setTriggerId(element.id); setOpen(true)
  }, blur: () => { suppressed.current = null }, activate: element => { suppressed.current = null; setAnimate(false); setTriggerId(element.id); setOpen(true) },
  dismiss: element => {
    if (!open || triggerId !== element.id) return false
    setOpen(false)
    return true
  } }
  return <Popover.Root<{ source: LibrarySource; sentence: string }> open={open} triggerId={triggerId} onOpenChange={(next, details) => {
    if (!next && details.reason === 'trigger-press' && 'detail' in details.event && details.event.detail === 0) { details.cancel(); return }
    if (details.reason === 'escape-key' && document.activeElement?.closest('.citation-card')) {
      suppressed.current = triggerId
      if (triggerId) document.getElementById(triggerId)?.focus({ preventScroll: true })
    }
    if (next) {
      if (!open || details.trigger?.id !== triggerId) setAnimate(details.reason === 'trigger-hover' || (details.reason === 'trigger-press' && 'detail' in details.event && details.event.detail > 0))
      setTriggerId(details.trigger?.id ?? triggerId)
    }
    setOpen(next)
  }}>{({ payload }) => { ctx.at.n = 0; return <>
    {(doc.content ?? []).map(n => render(n, ctx))}
    {payload && <SourceCitationCard key={triggerId} source={payload.source} sentence={payload.sentence} triggerId={triggerId} animate={animate} onOpen={match => { setOpen(false); onSource(payload.source, match) }} />}
  </> }}</Popover.Root>
}

type Ctx = { live: boolean; at: { n: number }; id: string; sources: LibrarySource[]; focus: (element: HTMLElement) => void; blur: () => void; activate: (element: HTMLElement) => void; dismiss: (element: HTMLElement) => boolean }

function render(node: PMNode, c: Ctx): ReactNode {
  const key = `${node.type}-${c.at.n}`
  if (node.type === 'citation') {
    c.at.n += Number(node.attrs?.length ?? 0)
    return <span className="citation-group" data-gap={node.attrs!.gap || undefined} data-single={(node.attrs!.marks as CitationMark[]).length === 1 || undefined} key={key}>{(node.attrs!.marks as CitationMark[]).map((mark, i) => {
      const source = c.sources.find(s => s.n === mark.source)!
      const title = source.title || t('Untitled')
      return <Popover.Trigger key={mark.source} id={`${c.id}-${key}-${mark.source}`} payload={(node.attrs!.payloads as Array<{ source: LibrarySource; sentence: string }>)[i]} openOnHover delay={100} closeDelay={180}
        className="source-citation" data-testid="source-citation" data-meeting={source.meetingId} data-at={source.atMs ?? undefined}
        aria-label={`${mark.number}: ${title} · ${dayLabel(source.startedAt)}`} onFocus={e => c.focus(e.currentTarget)} onBlur={c.blur} onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); c.activate(e.currentTarget) }
          // Consume Escape before the containing note panel handles it.
          if (e.key === 'Escape' && c.dismiss(e.currentTarget)) { e.preventDefault(); e.stopPropagation() }
        }}>
        {mark.number}
      </Popover.Trigger>
    })}</span>
  }
  if (node.type === 'citationAnchor') return <span key={key} className="citation-anchor">{node.content!.map(n => render(n, c))}</span>
  if (node.type === 'text') {
    const text = node.text ?? ''
    const out = words(text, c.at.n, c.live)
    c.at.n += text.length
    return <InlineText key={key} marks={node.marks}>{out}</InlineText>
  }
  const kids = (node.content ?? []).map(n => render(n, c))
  c.at.n += 1
  switch (node.type) {
    case 'heading': return <h3 key={key}>{kids}</h3>
    case 'bulletList': return <ul key={key}>{kids}</ul>
    case 'orderedList': return <ol key={key} start={Number(node.attrs?.start ?? 1)}>{kids}</ol>
    case 'listItem': return <li key={key}>{kids}</li>
    case 'paragraph': return node.content ? <p key={key}>{kids}</p> : null
    default: return <Fragment key={key}>{kids}</Fragment>
  }
}

function words(text: string, from: number, live: boolean): ReactNode[] {
  if (!live) return text ? [text] : []
  const out: ReactNode[] = []
  let at = from
  for (const w of text.split(/(\s+)/)) {
    if (w) out.push(/^\s+$/.test(w) ? w : <span key={at} className="fw">{w}</span>)
    at += w.length
  }
  return out
}
