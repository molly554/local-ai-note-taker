import { SPEAKER_COLORS } from '../../../shared/speakerColors'
import { widgetDragDelta, isWidgetClick, type WidgetPress } from '../../../shared/widgetGesture'
import { Loading } from '../components/Loading'
import { bubbles, turns, withLive } from '../../../shared/transcript'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, TriangleAlert } from 'lucide-react'
import type { Segment, TranscriptPartial, WidgetView } from '../../../shared/types'
import { formatElapsed } from '../../../shared/wave'
import { t } from '../../../shared/i18n'
import { Logo } from '../components/Logo'
import { LevelBars } from '../components/LevelBars'
import { LiveWords } from '../components/Transcript'
import { glide } from '../motion'
import { afterFinal, joinWords } from '../../../shared/liveWords'
import { ScrollFade } from '../components/ScrollFade'
import { useWidgetMorph } from './widgetMorph'
import { widgetSettings } from '../../../shared/widgetMorph'

function useElapsed(v: WidgetView | null): string {
  const [text, setText] = useState('0:00')
  useEffect(() => {
    if (!v) return
    const tick = () => setText(formatElapsed(v.kind === 'recording' && !v.paused ? v.elapsedMs + (Date.now() - v.at) : v.elapsedMs))
    tick()
    if (v.kind !== 'recording' || v.paused) return
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [v])
  return text
}

/** A click opens the note; a drag moves the recorder without opening it on release. */
function useDragOrClick(onClick: () => void, hover: ReturnType<typeof useWidgetMorph>) {
  const s = useRef<WidgetPress | null>(null)
  const cancel = () => {
    if (!s.current) return
    window.yogurt.widget.endDrag()
    hover.release(s.current.moved)
    s.current = null
  }
  useEffect(() => {
    const release = () => hover.release(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); window.yogurt.widget.endDrag(); window.yogurt.widget.pressed(false) }
  }, [])
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || s.current) return
      hover.press()
      if ((e.target as HTMLElement).closest('button')) return
      const scroll = (e.target as HTMLElement).closest<HTMLElement>('.widget-preview-conversation')
      if (scroll && e.clientX >= scroll.getBoundingClientRect().left + scroll.clientWidth) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      s.current = { x: e.screenX, y: e.screenY, pointerId: e.pointerId, at: e.timeStamp, moved: false }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = s.current
      hover.pointer(e.clientX, e.clientY)
      if (!d || e.pointerId !== d.pointerId) return
      const delta = widgetDragDelta(d, e.screenX, e.screenY)
      if (delta) window.yogurt.widget.drag(delta.dx, delta.dy)
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = s.current
      if (!d || e.pointerId !== d.pointerId) return
      const click = isWidgetClick(d, e.screenX, e.screenY, e.timeStamp)
      cancel()
      e.currentTarget.releasePointerCapture(e.pointerId)
      if (click) onClick()
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('button') || !['Enter', ' '].includes(e.key)) return
      e.preventDefault()
      if (!e.repeat) onClick()
    },
  }
}

function useWidgetView() {
  const [view, setView] = useState<WidgetView | null>(null)
  useEffect(() => {
    document.documentElement.classList.add('widget')
    void window.yogurt.widget.state().then(setView)
    return window.yogurt.widget.onState(setView)
  }, [])
  return view
}

/** One recording surface, with the transcript kept mounted between hovers. */
export function Widget() {
  const view = useWidgetView()
  return view?.kind === 'recording' && !view.paused ? <Recording key={view.meetingId} view={view} /> : null
}

function Recording({ view }: { view: WidgetView }) {
  const time = useElapsed(view)
  const card = useRef<HTMLDivElement>(null)
  const hover = useWidgetMorph(card, !!view.note, time)
  const press = useDragOrClick(() => window.yogurt.widget.open(), hover)
  return <div ref={card} data-testid="widget" data-kind="recording" data-open={hover.open} role="group" tabIndex={0}
    className="widget-pill widget-morph" {...press}
    onMouseMove={e => hover.pointer(e.clientX, e.clientY)}
    onMouseLeave={() => hover.pointer(-1, -1)}
    aria-label={t('Open {title}', { title: view.title })} title={view.note?.text ?? t('Recording {title}', { title: view.title })}>
    <div className="widget-details" aria-hidden="true">
      <span className="text-[var(--pill-accent)]">{view.note ? <TriangleAlert data-testid="widget-warning" size={18} /> : <Logo size={18} />}</span>
      <LevelBars testId="widget-wave" height={16} className="text-[var(--pill-accent)]" />
      <span data-testid="widget-time" className="widget-time">{time}</span>
    </div>
    <Preview view={view} open={hover.open} />
  </div>
}

const RECENT_LINES = 80

function Preview({ view, open }: { view: WidgetView; open: boolean }) {
  const [lines, setLines] = useState<Array<Omit<Segment, 'id'>>>([])
  const [parts, setParts] = useState<Record<string, TranscriptPartial>>({})
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const gliding = useRef<(() => void) | null>(null)
  const [behind, setBehind] = useState(false)
  // Older lines leave as new ones arrive, so a long meeting stays as light as a short one; not while scrolled up to read.
  const recentOnly = (l: Array<Omit<Segment, 'id'>>) => stick.current && l.length > RECENT_LINES ? l.slice(-RECENT_LINES) : l
  useEffect(() => {
    let alive = true
    // A hover shows recent context, read as a tail; the full transcript stays in the meeting.
    const refresh = () => { void window.yogurt.transcript.get(view.meetingId, { hidden: true, last: RECENT_LINES }).then((recent) => {
      if (!alive) return
      setLines(current => {
        const merged = new Map(current.map(s => [`${s.track}:${s.startMs}`, s]))
        for (const s of recent) merged.set(`${s.track}:${s.startMs}`, s)
        return recentOnly([...merged.values()].filter(s => !s.hidden).sort((a, b) => a.startMs - b.startMs))
      })
      setLoaded(true); setFailed(false)
    }, () => { if (alive) { setLoaded(true); setFailed(true) } }) }
    const offSegment = window.yogurt.transcript.onSegment((s) => {
      if (s.meetingId !== view.meetingId) return
      setLines(current => recentOnly([...current.filter(l => l.track !== s.track || l.startMs !== s.startMs), s].filter(l => !l.hidden).sort((a, b) => a.startMs - b.startMs)))
      setParts(current => {
        const had = current[s.track]
        if (!had) return current
        const words = afterFinal(had.words ?? [], { endMs: s.endMs, text: s.text })
        const next = { ...current }
        if (words.length) next[s.track] = { ...had, words, text: joinWords(words), startMs: words[0].startMs }; else delete next[s.track]
        return next
      })
    })
    const offPartial = window.yogurt.transcript.onPartial(p => {
      if (p.meetingId !== view.meetingId) return
      setParts(current => { const next = { ...current }; if (p.text) next[p.track] = p; else delete next[p.track]; return next })
    })
    const offNames = window.yogurt.transcript.onSpeakers(id => { if (id === view.meetingId) refresh() })
    refresh()
    return () => { alive = false; offSegment(); offPartial(); offNames() }
  }, [view.meetingId])
  const grouped = useMemo(() => turns(withLive(lines, Object.values(parts).map(p => ({
    ...p, words: p.words ?? [], endMs: p.words?.at(-1)?.endMs ?? p.startMs,
  })))), [lines, parts])
  useLayoutEffect(() => {
    if (stick.current && !gliding.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [grouped, loaded])
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (stick.current && !gliding.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
    })
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    gliding.current?.(); gliding.current = null
    stick.current = true; setBehind(false)
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [open])
  useEffect(() => () => gliding.current?.(), [])
  const manual = () => { gliding.current?.(); gliding.current = null; stick.current = false }
  const latest = () => {
    const el = scroll.current
    if (!el) return
    gliding.current?.()
    stick.current = true; setBehind(false)
    gliding.current = glide(el, el.scrollHeight - el.clientHeight, () => {
      requestAnimationFrame(() => {
        gliding.current = null
        if (stick.current) el.scrollTop = el.scrollHeight
      })
    })
  }
  const note = view.note
  const permission = widgetSettings(note)
  return <div data-testid="widget-preview" className="widget-preview" role="region" aria-label={t('Live transcript')} inert={!open} aria-hidden={!open}>
    {note && <div className="widget-preview-warning" role="status">
      <p data-testid="widget-note" data-tone={note.tone}>{note.text}</p>
      {permission && <button className="widget-settings" onClick={() => { void window.yogurt.permissions.open(permission) }}>{t('Open Settings')}</button>}
    </div>}
    <ScrollFade>
    <div ref={scroll} data-testid="widget-preview-text" className="widget-preview-conversation" role="log" aria-live="off" aria-label={t('Transcript')}
      onWheel={manual} onTouchStart={manual} onPointerDown={manual} onKeyDown={manual} onScroll={e => {
      if (gliding.current) return
      const el = e.currentTarget
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      setBehind(!stick.current)
    }}>
      <div ref={content}>
      {!loaded ? <Loading layout="transcript" testId="widget-preview-loading" /> : !grouped.length && <p className="widget-preview-empty">{failed ? t("Couldn't load the transcript. Open Yogurt to try again.") : t('Listening for speech…')}</p>}
      {grouped.map(turn => {
        const first = turn[0], me = first.track === 'me'
        const who = me ? t('You') : first.speaker || t('Them')
        const color = me || !('speakerColor' in first) ? undefined : first.speakerColor
        return <div key={`${first.track}:${first.startMs}`} className="widget-preview-turn" data-me={me}>
          <span className="widget-preview-speaker" data-color={color} data-folder-color={color === undefined ? undefined : SPEAKER_COLORS[color]}>{who}</span>
          {bubbles(turn).map(group => <p key={`${group[0].track}:${group[0].startMs}`} data-testid="widget-preview-bubble" className="widget-preview-bubble" dir="auto">
            {group.map((line, i) => <Fragment key={`${line.track}:${line.startMs}`}>{i > 0 && ' '}{'live' in line ? <LiveWords said={line.live} /> : line.text}</Fragment>)}
          </p>)}
        </div>
      })}
      </div>
    </div>
    </ScrollFade>
    {behind && <button data-testid="widget-preview-latest" className="widget-preview-latest" onClick={latest}><ArrowDown size={12} aria-hidden="true" />{t('Latest')}</button>}
  </div>
}
