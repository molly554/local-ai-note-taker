/**
 * Notes out of Yogurt: plain text and simple HTML for the clipboard (Gmail, Docs and Slack paste them cleanly), and a
 * Markdown file with the notes and the transcript. Built from the same document the editor uses (markdown.ts), so
 * what is copied is what is shown. The person's own words keep their text, not their styling.
 */
import { language, t } from './i18n'
import { docToMd, escapeText, mdToDoc, type PMNode } from './markdown'
import { clock, turns } from './transcript'
import type { Meeting, NoteStatus, Segment } from './types'

const kids = (n: PMNode) => n.content ?? []
const isList = (n: PMNode) => n.type === 'bulletList' || n.type === 'orderedList'
/** only web and mail links travel; anything else (javascript:) is just its text */
const safeHref = (h: string) => /^(https?:|mailto:)/i.test(h)

// ---------- plain text ----------

function inlineText(nodes: PMNode[]): string {
  return nodes.map((n) => {
    const href = n.marks?.find((m) => m.type === 'link')
    const text = n.text ?? ''
    return href && href.type === 'link' && safeHref(href.attrs.href) && href.attrs.href !== text ? `${text} (${href.attrs.href})` : text
  }).join('')
}

function listText(list: PMNode, depth: number, out: string[]) {
  let n = Number(list.attrs?.start ?? 1)
  for (const li of kids(list)) {
    const [first, ...rest] = kids(li)
    const mark = list.type === 'orderedList' ? `${n++}.` : '•'
    out.push(`${'  '.repeat(depth)}${mark} ${first?.type === 'paragraph' ? inlineText(kids(first)) : ''}`)
    for (const c of first?.type === 'paragraph' ? rest : kids(li)) {
      if (isList(c)) listText(c, depth + 1, out)
      else if (c.type === 'paragraph') out.push(`${'  '.repeat(depth + 1)}${inlineText(kids(c))}`)
    }
  }
}

function docText(doc: PMNode): string {
  const out: string[] = []
  for (const b of kids(doc)) {
    if (isList(b)) listText(b, 0, out)
    else out.push(inlineText(kids(b)))
  }
  return out.join('\n').replace(/\s+$/, '')
}

/** Notes as plain text: bullets as •, headings on their own lines, bold and the person's marks left as plain words */
export const toPlainText = (md: string): string => docText(mdToDoc(md))

// ---------- HTML ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineHtml(nodes: PMNode[]): string {
  return nodes.map((n) => {
    let s = esc(n.text ?? '')
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') s = `<strong>${s}</strong>`
      else if (m.type === 'italic') s = `<em>${s}</em>`
      else if (m.type === 'link' && safeHref(m.attrs.href)) s = `<a href="${esc(m.attrs.href)}">${s}</a>`
    }
    return s
  }).join('')
}

function listHtml(list: PMNode): string {
  const tag = list.type === 'orderedList' ? 'ol' : 'ul'
  const start = tag === 'ol' && Number(list.attrs?.start ?? 1) !== 1 ? ` start="${Number(list.attrs?.start)}"` : ''
  const items = kids(list).map((li) => {
    const [first, ...rest] = kids(li)
    const head = first?.type === 'paragraph' ? inlineHtml(kids(first)) : ''
    const tail = (first?.type === 'paragraph' ? rest : kids(li)).map((c) => (isList(c) ? listHtml(c) : c.type === 'paragraph' ? `<p>${inlineHtml(kids(c))}</p>` : '')).join('')
    return `<li>${head}${tail}</li>`
  })
  return `<${tag}${start}>${items.join('')}</${tag}>`
}

function docHtml(doc: PMNode): string {
  return kids(doc).map((b) => {
    if (isList(b)) return listHtml(b)
    // blank lines only separate paragraphs, and an empty heading is nothing
    const inner = inlineHtml(kids(b))
    if (!inner) return ''
    if (b.type === 'heading') { const h = Number(b.attrs?.level) >= 3 ? 'h3' : 'h2'; return `<${h}>${inner}</${h}>` }
    return `<p>${inner}</p>`
  }).join('')
}

/** What goes on the clipboard for these notes: both formats, so the place pasted into takes the one it likes */
export function toClipboard(md: string): { text: string; html: string } {
  const doc = mdToDoc(md)
  return { text: docText(doc), html: docHtml(doc) }
}

/** The same for a transcript */
export function transcriptClipboard(lines: Segment[]): { text: string; html: string } {
  const doc = transcriptDoc(lines)
  return { text: docText(doc), html: docHtml(doc) }
}

// ---------- transcript ----------

/** Who said a line: You on the mic; on the other side the name the call showed, Them when it showed none */
export const whoSaid = (l: Pick<Segment, 'track' | 'speaker'>): string => (l.track === 'me' ? t('You') : l.speaker || t('Them'))

const text = (s: string, bold = false): PMNode => (bold ? { type: 'text', text: s, marks: [{ type: 'bold' }] } : { type: 'text', text: s })
const para = (...content: PMNode[]): PMNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })

/** A transcript as a document: a bold name and time, then what they said, a blank line between turns */
export function transcriptDoc(lines: Segment[], o: { gap?: boolean } = {}): PMNode {
  const content: PMNode[] = []
  for (const turn of turns([...lines].sort((a, b) => a.startMs - b.startMs))) {
    if (content.length) content.push(para())
    content.push(para(text(whoSaid(turn[0]), true), text(` (${clock(turn[0].startMs)})`)))
    // in the file a blank line keeps viewers from running the name into the words
    if (o.gap) content.push(para())
    content.push(para(text(turn.map((l) => l.text.trim()).join(' '))))
  }
  return { type: 'doc', content: content.length ? content : [para()] }
}

// ---------- file ----------

/** The Markdown file: title, date, people, the notes, then the transcript with names */
export function toMarkdownFile(meeting: Meeting, notes: string, segments: Segment[]): string {
  const when = new Date(meeting.startedAt).toLocaleString(language(), { dateStyle: 'long', timeStyle: 'short' })
  const title = meeting.title.replace(/\s+/g, ' ').trim()
  const head = [`# ${escapeText(title)}`, '', when]
  const people = meeting.attendees.map((a) => a.name.trim()).filter(Boolean)
  if (people.length) head.push('', t('With: {names}', { names: people.join(', ') }))
  const body = notes.replace(/<\/?mine>/g, '').trim()
  const out = [head.join('\n')]
  if (body) out.push(body)
  if (segments.length) out.push(`## ${t('Transcript')}\n\n${docToMd(transcriptDoc(segments, { gap: true }))}`)
  return out.join('\n\n') + '\n'
}

/** "<title> <day>.md" with nothing a file name cannot hold; never a hidden file or a very long one */
export function fileNameFor(title: string, startedAt: number): string {
  const d = new Date(startedAt)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').trim()
  // cut by whole characters, never through an emoji
  const short = Array.from(clean).slice(0, 80).join('').trim()
  return `${short || t('Meeting')} ${day}.md`
}

/**
 * What copy and export take, so it is what the person is looking at: the Enhanced tab while the notes are still
 * being written copies nothing (writing). A failed rewrite keeps the previous Enhanced result available;
 * without one (or when nothing was said), My notes go instead and the person is told (fellBack).
 */
export function shareTarget(shown: 'mine' | 'enhanced', status: NoteStatus, hasEnhanced = false): { side: 'mine' | 'enhanced'; writing: boolean; fellBack: boolean } {
  if (shown === 'mine') return { side: 'mine', writing: false, fellBack: false }
  if (status === 'waiting' || status === 'writing') return { side: 'enhanced', writing: true, fellBack: false }
  if ((status === 'failed' && !hasEnhanced) || status === 'empty') return { side: 'mine', writing: false, fellBack: true }
  return { side: 'enhanced', writing: false, fellBack: false }
}
