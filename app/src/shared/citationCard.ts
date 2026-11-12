import type { LibrarySource } from './types'
import { mdToDoc, type PMNode } from './markdown'
import { citationExcerptLines, citationExcerptText, citationPassage, citationTargetIndex } from './citations'
import { speakerColor, SPEAKER_COLORS } from './speakerColors'

/** Select existing inline nodes, keeping formatting without interpreting links or HTML. */
function inlineExcerpt(excerpt: string, text: string): PMNode[] {
  for (const nodes of citationExcerptLines(excerpt)) {
    const start = nodes.map(n => n.text ?? '').join('').indexOf(text)
    if (start < 0 || !text) continue
    let offset = 0
    return nodes.flatMap(node => {
      const value = node.text ?? '', from = Math.max(0, start - offset), to = Math.min(value.length, start + text.length - offset)
      offset += value.length
      return to > from ? [{ ...node, text: value.slice(from, to) }] : []
    })
  }
  return [{ type: 'text', text }]
}

/** Keep the selected sentences inside their original list items, including ordered-list offsets. */
function notesDoc(excerpt: string, passage: ReturnType<typeof citationPassage>): PMNode[] {
  const used = new Set<string>()
  const visit = (node: PMNode): PMNode[] => {
    if (node.type === 'paragraph' || node.type === 'heading') {
      const text = (node.content ?? []).map(n => n.text ?? '').join('')
      return (['before', 'match', 'after'] as const).flatMap(part => {
        if (!passage[part] || used.has(part) || !text.includes(passage[part])) return []
        used.add(part)
        return [{ type: 'citationPart', attrs: { part }, content: inlineExcerpt(excerpt, passage[part]) }]
      })
    }
    const children = (node.content ?? []).map((child, index) => visit(child).map(item => node.type === 'orderedList'
      ? { ...item, attrs: { ...item.attrs, value: Number(node.attrs?.start ?? 1) + index } } : item)), content = children.flat()
    if (!content.length) return []
    return [{ ...node, content, ...(node.type === 'orderedList' ? { attrs: { ...node.attrs, start: Number(node.attrs?.start ?? 1) + children.findIndex(c => c.length) } } : {}) }]
  }
  return visit(mdToDoc(excerpt.replace(/^[\t ]*#{4,6}[\t ]+/gm, '### '), { inlineCode: true }))[0]?.content ?? []
}

export function citationCardPassage(source: LibrarySource, answerSentence: string) {
  const kind = source.atMs === null ? 'notes' : 'transcript'
  const lines = source.transcript?.lines ?? []
  let excerpt = source.excerpt ?? ''
  if (kind === 'transcript') {
    // Strip only prefixes verified against actual speech, never infer a name from an arbitrary colon.
    excerpt = citationExcerptText(excerpt).split('\n').map(text => {
      for (const line of lines) {
        const prefix = `${line.track === 'me' ? 'You' : line.speaker || 'Them'}: `
        if (text.startsWith(prefix) && (text.slice(prefix.length).startsWith(citationExcerptText(line.text)) || citationExcerptText(line.text).startsWith(text.slice(prefix.length)))) return text.slice(prefix.length)
      }
      return text
    }).join('\n')
  }
  const passage = citationPassage(excerpt, answerSentence)
  const near = Math.max(0, lines.findIndex(line => line.startMs === source.atMs))
  const part = (text: string) => {
    const line = kind === 'transcript' ? lines[citationTargetIndex(lines.map(l => l.text), text, near)] : undefined
    const color = speakerColor(line?.track ?? 'them', line?.speaker, source.transcript?.speakers ?? [])
    return { text, nodes: kind === 'notes' ? inlineExcerpt(excerpt, text) : [], track: line?.track ?? 'them',
      speaker: line?.speaker, color: color === undefined ? undefined : SPEAKER_COLORS[color], atMs: line?.startMs }
  }
  const match = part(passage.match)
  const speech = kind === 'transcript' ? lines.flatMap(line => {
    const text = citationExcerptText(line.text)
    if (text && excerpt.includes(text)) return [{ ...line, text }]
    if (text && excerpt.endsWith('\n…')) {
      const tail = excerpt.slice(0, -2), start = tail.lastIndexOf(text.split(/\s/)[0])
      const clipped = start < 0 ? '' : tail.slice(start)
      if (clipped && text.startsWith(clipped)) return [{ ...line, text: clipped + '…' }]
    }
    return []
  }) : []
  const transcriptLines = speech.length ? speech : kind === 'transcript'
    ? excerpt.split('\n').filter(text => text.trim()).map(text => ({ text, track: 'them' as const, speaker: null, startMs: source.atMs! })) : []
  const matchedLine = Math.max(0, citationTargetIndex(transcriptLines.map(l => l.text), match.text, Math.max(0, transcriptLines.findIndex(l => l.startMs === match.atMs))))
  return { kind, before: part(passage.before), match, after: part(passage.after), notes: kind === 'notes' ? notesDoc(excerpt, passage) : [],
    lines: transcriptLines.map((line, index) => {
      const color = speakerColor(line.track, line.speaker, source.transcript?.speakers ?? [])
      return { ...line, index, color: color === undefined ? undefined : SPEAKER_COLORS[color] }
    }), matchedLine }
}

/** Drop the most distant whole lines first; the matched line is never removed. */
export function citationLineWindow(heights: number[], match: number): { start: number; end: number } {
  let start = 0, end = heights.length, count = heights.reduce((a, b) => a + b, 0)
  while (count > 6 && end - start > 1) {
    if (match - start > end - 1 - match) count -= heights[start++]
    else count -= heights[--end]
  }
  return { start, end }
}
