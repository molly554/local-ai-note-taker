/**
 * Markdown to the editor's document (TipTap / ProseMirror JSON) and back, for the small part of Markdown notes use:
 * headings, bullets and numbered lists (nested), bold, italic, links, and <mine>…</mine> (the person's own words in
 * the enhanced notes, shown darker). JSON both ways keeps it pure, so it is tested without a browser.
 */
export type Mark = { type: 'bold' | 'italic' | 'mine' | 'code' } | { type: 'link'; attrs: { href: string } }
export type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: Mark[] }

type Opts = { streaming?: boolean; inlineCode?: boolean }

const HEADING = /^(#{1,3})\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

// ---------- inline ----------

/** characters a backslash makes literal (docToMd escapes what the person typed with these) */
const ESCAPABLE = '\\*_[]<#-+.)'
/** where `d` next appears from `from`, skipping escaped copies */
function findClose(text: string, d: string, from: number): number {
  for (let i = text.indexOf(d, from); i !== -1; i = text.indexOf(d, i + 1)) {
    let slashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) return i
  }
  return -1
}

/** Closing stars can belong to nested emphasis: ***both*** closes italic before bold. */
function emphasisClose(text: string, d: string, from: number): number {
  if (d[0] !== '*') return findClose(text, d, from)
  let nested = false
  for (let i = findClose(text, '*', from); i !== -1; i = findClose(text, '*', i)) {
    let end = i + 1
    while (text[end] === '*') end++
    const count = end - i
    if (count >= d.length && (d.length === 2 || count !== 2)) {
      const inner = nested ? (d.length === 2 ? 1 : 2) : 0
      if (count >= d.length + inner) return i + inner
    }
    nested = !nested
    i = end
  }
  return -1
}

const sameMark = (a: Mark, b: Mark) => a.type === b.type && (a.type !== 'link' || (b.type === 'link' && a.attrs.href === b.attrs.href))

/** A half-written tag at the very end of streamed text ("<mi", "</min") is hidden until it is whole */
const PARTIAL_TAG = /<\/?(m(i(n(e)?)?)?)?$/

function inline(text: string, o: Opts, marks: Mark[] = []): PMNode[] {
  if (o.streaming) text = text.replace(PARTIAL_TAG, '')
  const out: PMNode[] = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    const prev = out.at(-1)
    // neighbours with the same marks are one text node, as the editor keeps them
    if (prev && prev.text !== undefined && JSON.stringify(prev.marks ?? []) === JSON.stringify(marks)) prev.text += buf
    else out.push(marks.length ? { type: 'text', text: buf, marks } : { type: 'text', text: buf })
    buf = ''
  }
  const wrap = (inner: string, mark: Mark) => { flush(); for (const n of inline(inner, { ...o, streaming: false }, [...marks, mark])) merge(out, n) }
  const open = (inner: string, mark: Mark) => { flush(); for (const n of inline(inner, o, [...marks, mark])) merge(out, n) }

  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const prevCh = i > 0 ? text[i - 1] : ' '
    if (rest[0] === '\\' && rest.length > 1 && ESCAPABLE.includes(rest[1])) { buf += rest[1]; i += 2; continue }
    if (o.inlineCode && rest[0] === '`') {
      const delimiter = /^`+/.exec(rest)![0]
      const after = rest.slice(delimiter.length)
      const end = new RegExp('(?<!`)' + delimiter + '(?!`)').exec(after)
      if (end || o.streaming) {
        let code = after.slice(0, end?.index).replace(/\n/g, ' ')
        if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1)
        flush(); out.push({ type: 'text', text: code, marks: [...marks, { type: 'code' }] })
        i += delimiter.length + (end ? end.index + delimiter.length : after.length)
        continue
      }
    }
    if (rest.startsWith('<mine>')) {
      const end = findClose(text, '</mine>', i + 6)
      if (end !== -1) { wrap(text.slice(i + 6, end), { type: 'mine' }); i = end + 7; continue }
      // the model never closed it: to the end (a stray tag is dropped either way)
      open(text.slice(i + 6), { type: 'mine' }); return out
    }
    if (rest.startsWith('</mine>')) { i += 7; continue }
    const nextStar = rest.startsWith('***') ? findClose(text, '*', i + 3) : -1
    const italicOutside = nextStar !== -1 && text.slice(nextStar, nextStar + 2) === '**' && text[nextStar + 2] !== '*'
    if (rest.startsWith('**') && !italicOutside || rest.startsWith('__') && !/\w/.test(prevCh)) {
      const d = rest.slice(0, 2)
      const end = emphasisClose(text, d, i + 2)
      if (end > i + 2) { wrap(text.slice(i + 2, end), { type: 'bold' }); i = end + 2; continue }
      if (o.streaming && end === -1) { open(text.slice(i + 2), { type: 'bold' }); return out }
    }
    if ((rest[0] === '*' && rest[1] !== ' ' && (rest[1] !== '*' || italicOutside)) || (rest[0] === '_' && !/\w/.test(prevCh) && rest[1] !== '_')) {
      const d = rest[0]
      let end = emphasisClose(text, d, i + 1)
      // an underscore closes only at the end of a word, so snake_case stays as typed
      while (d === '_' && end !== -1 && /\w/.test(text[end + 1] ?? '')) end = findClose(text, d, end + 1)
      if (end > i + 1 && text[end - 1] !== ' ') { wrap(text.slice(i + 1, end), { type: 'italic' }); i = end + 1; continue }
      if (o.streaming && end === -1 && rest.length > 1) { open(text.slice(i + 1), { type: 'italic' }); return out }
    }
    if (rest[0] === '[') {
      const m = /^\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/.exec(rest)
      if (m) { wrap(m[1], { type: 'link', attrs: { href: m[2] } }); i += m[0].length; continue }
      // a link still being written shows as its text
      if (o.streaming && /^\[[^\]]*(\]\([^)]*)?$/.test(rest)) { buf += rest.slice(1).replace(/\]\(.*$/, ''); break }
    }
    buf += text[i]
    i++
  }
  flush()
  return out
}

function merge(out: PMNode[], n: PMNode) {
  const prev = out.at(-1)
  if (prev && prev.text !== undefined && n.text !== undefined && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) prev.text += n.text
  else out.push(n)
}

const para = (text: string, o: Opts): PMNode => {
  const content = inline(text, o)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

// ---------- blocks ----------

export function mdToDoc(md: string, o: Opts = {}): PMNode {
  // While streaming, nothing shows until it has a character to show: a trailing blank line or a bare list or
  // heading marker would open an empty block, and the caret dot would drop to it and back up as text arrives.
  if (o.streaming) md = md.trimEnd().replace(/(^|\n)[\t ]*(?:[-*+]|\d+[.)]|#{1,6})$/, '').trimEnd()
  const content: PMNode[] = []
  // open lists, outermost first: the indent their items start at, and the list node
  let stack: Array<{ indent: number; list: PMNode }> = []
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    // a blank line is an empty paragraph: what the person typed comes back as it was
    if (!line.trim()) { stack = []; content.push({ type: 'paragraph' }); continue }
    const item = ITEM.exec(line)
    if (item) {
      const indent = item[1].replace(/\t/g, '  ').length
      const type = /\d/.test(item[2]) ? 'orderedList' : 'bulletList'
      while (stack.length && stack.at(-1)!.indent > indent) stack.pop()
      let top = stack.at(-1)
      if (top && top.indent === indent && top.list.type !== type) { stack.pop(); top = stack.at(-1) }
      const li: PMNode = { type: 'listItem', content: [para(item[3], o)] }
      if (top && top.indent === indent) top.list.content!.push(li)
      else {
        const list: PMNode = type === 'orderedList' ? { type, attrs: { start: Number(item[2].replace(/\D/g, '')) || 1 }, content: [li] } : { type, content: [li] }
        // deeper than the open list: it belongs to that list's last item
        if (top) top.list.content!.at(-1)!.content!.push(list)
        else content.push(list)
        stack.push({ indent, list })
      }
      continue
    }
    stack = []
    const h = HEADING.exec(line.trim())
    if (h) {
      const inner = inline(h[2], o)
      content.push(inner.length ? { type: 'heading', attrs: { level: h[1].length }, content: inner } : { type: 'heading', attrs: { level: h[1].length } })
      continue
    }
    content.push(para(raw, o))
  }
  if (o.streaming) withoutEmptyEnd(content)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

const hasText = (n: PMNode): boolean => !!n.text?.trim() || !!n.content?.some(hasText)
/** while streaming, a block at the end with no text yet (a bullet whose bold has only just opened) waits for its text, so the dot doesn't drop to it and back */
function withoutEmptyEnd(nodes: PMNode[]) {
  while (nodes.length && !hasText(nodes.at(-1)!)) nodes.pop()
  const last = nodes.at(-1)
  if (last?.content && /List$|^listItem$/.test(last.type)) withoutEmptyEnd(last.content)
}

// ---------- back to Markdown ----------

const OPEN: Record<string, (m: Mark) => string> = { link: () => '[', mine: () => '<mine>', bold: () => '**', italic: () => '*' }
const CLOSE: Record<string, (m: Mark) => string> = { link: (m) => `](${m.type === 'link' ? m.attrs.href : ''})`, mine: () => '</mine>', bold: () => '**', italic: () => '*' }
/** outermost first, so <mine>**bold**</mine> and **bold** inside a link come out nested */
const ORDER = ['mine', 'link', 'bold', 'italic']

/** what the person typed, with anything that reads as Markdown made literal */
export const escapeText = (t: string) => t.replace(/[\\*_[\]]/g, '\\$&').replace(/<(?=\/?mine>)/g, '\\<')
/** a paragraph that starts like a heading or a list item stays a paragraph */
const escapeStart = (line: string) => line.replace(/^(\s*)([#+-])/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2')

function inlineMd(nodes: PMNode[] = []): string {
  let out = ''
  let open: Mark[] = []
  for (const [index, n] of nodes.entries()) {
    if (n.type === 'hardBreak') { out += ' '; continue }
    const extent = (mark: Mark) => {
      let end = index + 1
      while (end < nodes.length && nodes[end].marks?.some(m => sameMark(m, mark))) end++
      return end
    }
    // Keep the longer emphasis outside, avoiding adjacent closing/opening stars.
    const want = (n.marks ?? []).filter(m => m.type !== 'code').sort((a, b) => {
      if (['bold', 'italic'].includes(a.type) && ['bold', 'italic'].includes(b.type)) return extent(b) - extent(a) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type)
      return ORDER.indexOf(a.type) - ORDER.indexOf(b.type)
    })
    // keep the marks both share from the outside in; close the rest and open the new ones
    let keep = 0
    while (keep < open.length && keep < want.length && sameMark(open[keep], want[keep])) keep++
    for (let i = open.length - 1; i >= keep; i--) out += CLOSE[open[i].type](open[i])
    for (let i = keep; i < want.length; i++) out += OPEN[want[i].type](want[i])
    open = want
    const text = n.text ?? ''
    if (n.marks?.some(m => m.type === 'code')) {
      const ticks = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length)) + 1)
      const pad = /^[` ]|[` ]$/.test(text) ? ' ' : ''
      out += `${ticks}${pad}${text}${pad}${ticks}`
    } else out += escapeText(text)
  }
  for (let i = open.length - 1; i >= 0; i--) out += CLOSE[open[i].type](open[i])
  return out
}

function listMd(list: PMNode, indent: string, lines: string[]) {
  let n = Number(list.attrs?.start ?? 1)
  for (const li of list.content ?? []) {
    const bullet = list.type === 'orderedList' ? `${n++}. ` : '- '
    const [first, ...rest] = li.content ?? []
    lines.push(`${indent}${bullet}${first?.type === 'paragraph' ? inlineMd(first.content) : ''}`)
    const inner = indent + ' '.repeat(bullet.length)
    for (const c of first?.type === 'paragraph' ? rest : li.content ?? []) {
      if (c.type === 'bulletList' || c.type === 'orderedList') listMd(c, inner, lines)
      else if (c.type === 'paragraph') lines.push(`${inner}${escapeStart(inlineMd(c.content))}`)
    }
  }
}

export function docToMd(doc: PMNode): string {
  const lines: string[] = []
  for (const b of doc.content ?? []) {
    if (b.type === 'heading') lines.push(`${'#'.repeat(Number(b.attrs?.level ?? 2))} ${inlineMd(b.content)}`)
    else if (b.type === 'bulletList' || b.type === 'orderedList') listMd(b, '', lines)
    else if (b.type === 'paragraph') lines.push(escapeStart(inlineMd(b.content)))
  }
  return lines.join('\n')
}
