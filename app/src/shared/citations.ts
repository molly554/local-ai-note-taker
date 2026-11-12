import { mdToDoc, type PMNode } from './markdown'

/**
 * Citations in an answer across meetings: [1], [2, 3] point at the numbered sources it was given. Tidied the same way
 * in the window as it is written and in what is saved, so a mark never shows that would later go.
 */

/** one [1] or [1, 2] */
export const CITE = /\[(\d+(?:\s*,\s*\d+)*)\]/g
/** citations side by side ("[1][2] [3]"): read as one */
const RUN = /\[\d+(?:\s*,\s*\d+)*\](?:\s*\[\d+(?:\s*,\s*\d+)*\])*/g
/** with this many meetings or more found, a citation naming most of them is a pile, not a source */
const PILE_FROM = 4

const numbers = (run: string) => [...run.matchAll(CITE)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim())))

/** the source numbers an answer cites, in order, each once */
export const citedIn = (answer: string): number[] => [...new Set(numbers(answer))]

/**
 * The answer with each run of citations as one: numbers that were never given out (a small model sometimes makes one
 * up), a meeting cited once however many of its parts were (its first part wins), and a pile naming most of the
 * meetings dropped (a small model cites everything it was given, even when it says nothing there answers).
 */
export function tidyCitations(answer: string, sources: Array<{ n: number; meetingId: string }>): string {
  const meetingOf = new Map(sources.map((s) => [s.n, s.meetingId]))
  const meetings = new Set(meetingOf.values()).size
  return answer.replace(RUN, (run) => {
    const seen = new Set<string>()
    const kept = numbers(run).filter((n) => {
      const m = meetingOf.get(n)
      if (m === undefined || seen.has(m)) return false
      seen.add(m)
      return true
    })
    if (meetings >= PILE_FROM && seen.size > meetings / 2) return ''
    return kept.length ? `[${kept.join(', ')}]` : ''
  }).replace(/ +([.,;:!?])/g, '$1').replace(/ +$/gm, '').replace(/ {2,}/g, ' ')
}

export type CitationMark = { source: number; number: number }

const TERMINAL = /[.!?…](?=$|[\s"'”’)\]]|\p{Lu})/u
const CLOSING = /^[ \t]*([.!?…"'”’)\]]+)/u

/** Move only sentence punctuation, retaining the Markdown marks on the text it came from. */
function placeCitations(nodes: PMNode[], pending: boolean): PMNode[] {
  const out: PMNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'citation') { if (node.text) out.push(node); continue }
    while (out.at(-1)?.type === 'text') {
      const previous = out.at(-1)!
      previous.text = previous.text!.trimEnd()
      if (previous.text) break
      out.pop()
    }
    const before = out.map(n => n.text ?? '').join('')
    const after = nodes.slice(i + 1).map(n => n.text ?? '').join('')
    const ended = /[.!?…]["'”’)\]]*$/.test(before)
    const prefix = CLOSING.exec(after)
    const rest = prefix ? after.slice(prefix[0].length) : after
    if (prefix && (ended || (TERMINAL.test(prefix[1] + rest) && /[.!?…]/.test(prefix[1])) || (!pending && !rest.trim()))) {
      let take = prefix[0].length, spaces = take - prefix[1].length
      for (let j = i + 1; take && nodes[j]?.type === 'text'; j++) {
        const next = nodes[j], count = Math.min(take, next.text!.length)
        const punctuation = next.text!.slice(Math.min(spaces, count), count)
        if (punctuation) out.push({ ...next, text: punctuation })
        next.text = next.text!.slice(count)
        spaces = Math.max(0, spaces - count); take -= count
      }
    }
    // A trailing streamed mark cannot be placed until punctuation or the next sentence arrives.
    if (!pending || ended || TERMINAL.test(after) || /^\s+["“(]*\p{Lu}/u.test(after)) {
      node.attrs!.gap = /[\p{L}\p{N}\p{M}]$/u.test(out.at(-1)?.text ?? '')
      out.push(node)
    }
  }
  const sentences = sourceSentences(out.map(n => n.text ?? '').join(''))
  let offset = 0
  for (const node of out) {
    if (node.type === 'citation') node.attrs!.sentence = sentences.find(s => offset > s.index && offset <= s.end)?.text ?? ''
    offset += node.text?.length ?? 0
  }
  const bound: PMNode[] = []
  for (const node of out) {
    if (node.type !== 'citation') { bound.push(node); continue }
    const content = [node]
    // A word may cross Markdown spans; retain their marks inside one nonbreaking wrapper.
    while (bound.at(-1)?.type === 'text') {
      const previous = bound.at(-1)!, word = /\S+$/.exec(previous.text ?? '')
      if (!word) break
      bound.pop()
      content.unshift({ ...previous, text: word[0] })
      if (word.index) { bound.push({ ...previous, text: previous.text!.slice(0, word.index) }); break }
    }
    bound.push(content.length > 1 ? { type: 'citationAnchor', content } : node)
  }
  return bound
}

/** Keep the source IDs intact; visible numbers belong to meetings, in this answer's reading order. */
export function citationDoc(answer: string, sources: Array<{ n: number; meetingId: string }>, live = false): PMNode {
  const text = tidyCitations(live ? answer.replace(/\[[\d,\s]*$/, '') : answer, sources)
  const doc = mdToDoc(text.replace(/\n{2,}/g, '\n'), { streaming: live })
  const meetingOf = new Map(sources.map(s => [s.n, s.meetingId]))
  const numbers = new Map<string, number>()
  const lastBlock = (node: PMNode): PMNode => node.content?.length && node.type !== 'paragraph' && node.type !== 'heading' ? lastBlock(node.content.at(-1)!) : node
  const pending = live ? lastBlock(doc) : null
  const transform = (node: PMNode): PMNode[] => {
    if (node.type !== 'text') {
      if (!node.content) return [node]
      const content = node.content.flatMap(transform)
      return [{ ...node, content: node.type === 'paragraph' || node.type === 'heading' ? placeCitations(content, node === pending) : content }]
    }
    const text = node.text ?? '', parts: PMNode[] = []
    let last = 0
    for (const match of text.matchAll(CITE)) {
      if (match.index > last) parts.push({ ...node, text: text.slice(last, match.index) })
      const marks: CitationMark[] = []
      for (const n of match[1].split(',').map(Number)) {
        const meeting = meetingOf.get(n)
        if (meeting === undefined) continue
        if (!numbers.has(meeting)) numbers.set(meeting, numbers.size + 1)
        marks.push({ source: n, number: numbers.get(meeting)! })
      }
      if (marks.length) parts.push({ type: 'citation', attrs: { marks, length: match[0].length } })
      last = match.index + match[0].length
    }
    if (last < text.length) parts.push({ ...node, text: text.slice(last) })
    return parts
  }
  return transform(doc)[0]
}

/** Block syntax becomes line breaks in the small preview; only inline formatting is retained. */
export function citationExcerptLines(text: string): PMNode[][] {
  const doc = mdToDoc(text.replace(/^[\t ]*#{4,6}[\t ]+/gm, '### '), { inlineCode: true })
  const lines = (node: PMNode): PMNode[][] => node.type === 'paragraph' || node.type === 'heading'
    ? [node.content ?? []] : (node.content ?? []).flatMap(lines)
  return lines(doc)
}

/** Transcript excerpts use the same parsing, without presenting formatting as part of someone's speech. */
export const citationExcerptText = (text: string): string => citationExcerptLines(text).map(line => line.map(n => n.text ?? '').join('')).join('\n')

const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })
function sourceSentences(text: string): Array<{ text: string; index: number; end: number }> {
  let offset = 0
  return text.split('\n').flatMap(line => {
    const base = offset
    offset += line.length + 1
    return [...segmenter.segment(line)].filter(s => s.segment.trim()).map(s => ({
      text: s.segment.trim(), index: base + s.index, end: base + s.index + s.segment.length,
    }))
  })
}
const common = new Set('a an and are as at be been but by can did do for from had has have he her his how i in is it its me my of on or our she so that the their them there these they this to was we were what when which who will with would you your'.split(' '))
const tokens = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !common.has(w)))

/** The source is quoted, never generated. Ties (including no overlap) keep the earliest sentence. */
export function citationPassage(excerpt: string, answerSentence: string): { before: string; match: string; after: string } {
  const sentences = sourceSentences(citationExcerptText(excerpt)).map(s => s.text)
  const answer = tokens(answerSentence)
  let best = 0, score = -1
  sentences.forEach((sentence, i) => {
    const overlap = [...tokens(sentence)].filter(word => answer.has(word)).length
    if (overlap > score) { best = i; score = overlap }
  })
  return { before: sentences[best - 1] ?? '', match: sentences[best] ?? '', after: sentences[best + 1] ?? '' }
}

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
/** Locate an unchanged quote in a note block or transcript segment, tolerating Markdown and speaker prefixes. */
export function citationTargetIndex(lines: string[], match: string, near = 0): number {
  const needle = normalized(match)
  if (!needle) return -1
  const texts = lines.map(text => normalized(citationExcerptText(text)))
  const closest = (indices: number[]) => indices.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0] ?? -1
  const full = closest(texts.flatMap((text, i) => text.includes(needle) ? [i] : []))
  if (full >= 0) return full
  // A speaker-prefixed sentence can span multiple timestamped segments.
  const speech = normalized(match.replace(/^[^:\n]{1,80}:\s*/, ''))
  const joined = texts.join(' '), found = joined.indexOf(speech)
  if (speech && found >= 0) {
    let offset = 0
    return texts.findIndex(text => { offset += text.length + 1; return offset > found })
  }
  return closest(texts.flatMap((text, i) => text && needle.includes(text) ? [i] : []))
}
