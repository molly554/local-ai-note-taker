import { describe, expect, it } from 'vitest'
import { docToMd, mdToDoc, type PMNode } from '../src/shared/markdown'

const roundTrip = (md: string) => docToMd(mdToDoc(md))
const p = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const para = (text: string): PMNode => ({ type: 'doc', content: [p(text)] })
const docRoundTrip = (doc: PMNode) => mdToDoc(docToMd(doc))

describe('markdown', () => {
  it('turns <mine> lines into a marked span', () => {
    const doc = mdToDoc('- <mine>Ship on Tuesday</mine> after review')
    const item = doc.content![0].content![0].content![0]
    expect(item.content).toEqual([
      { type: 'text', text: 'Ship on Tuesday', marks: [{ type: 'mine' }] },
      { type: 'text', text: ' after review' },
    ])
  })
  it('reads headings, nested bullets, numbered lists, bold, italic and links', () => {
    const doc = mdToDoc('## Plan\n- **Maya:** send it\n  - *soon*, see [doc](https://x.io)\n1. first')
    expect(doc.content!.map((n) => n.type)).toEqual(['heading', 'bulletList', 'orderedList'])
    expect(doc.content![0].attrs).toEqual({ level: 2 })
    const first = doc.content![1].content![0]
    expect(first.content![0].content![0]).toEqual({ type: 'text', text: 'Maya:', marks: [{ type: 'bold' }] })
    const nested = first.content![1]
    expect(nested.type).toBe('bulletList')
    expect(nested.content![0].content![0].content).toEqual([
      { type: 'text', text: 'soon', marks: [{ type: 'italic' }] },
      { type: 'text', text: ', see ' },
      { type: 'text', text: 'doc', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] },
    ])
  })
  it('round-trips what it reads', () => {
    for (const md of [
      '## Plan\n- **Maya:** send it\n  - *soon*, see [doc](https://x.io)\n- <mine>my **own** line</mine>',
      'one line\nanother line',
      '# Big\n1. first\n2. second\n   - inner',
      '',
    ]) expect(roundTrip(md)).toBe(md)
  })
  it('keeps a snake_case word as typed', () => {
    expect(docRoundTrip(para('call send_email now'))).toEqual(para('call send_email now'))
  })
  it('keeps combined bold and italic formatting when saved and reopened', () => {
    for (const md of ['***both***', '**bold *both***', '***both* bold**', '*italic **both** italic*', '- ***both***', '[***both***](https://example.com)']) {
      expect(roundTrip(md)).toBe(md)
    }
    expect(mdToDoc('***both***').content![0].content).toEqual([
      { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ])
  })
  it('preserves adjoining and overlapping bold/italic selections through saving', () => {
    const sets = [[], [{ type: 'bold' }], [{ type: 'italic' }], [{ type: 'bold' }, { type: 'italic' }]] as const
    const characters = (doc: PMNode) => doc.content!.flatMap(p => p.content ?? []).flatMap(n =>
      [...(n.text ?? '')].map(char => [char, (n.marks ?? []).map(m => m.type).sort().join(',')]))
    for (const a of sets) for (const b of sets) for (const c of sets) {
      const doc: PMNode = { type: 'doc', content: [{ type: 'paragraph', content: [a, b, c].map((marks, i) =>
        ({ type: 'text', text: ['one', 'two', 'three'][i], marks: [...marks] })) }] }
      expect(characters(docRoundTrip(doc))).toEqual(characters(doc))
    }
  })
  // their own notes come back exactly as typed: what looks like Markdown in plain text is escaped
  for (const text of ['2*3*4', 'a <mine>tag</mine> typed', '1) item', '# not a heading', '- not a bullet', 'back\\slash \\*', '[not](a link)', 'x_y_z and _a_']) {
    it(`keeps typed text "${text}" as typed`, () => {
      const doc = para(text)
      const md = docToMd(doc)
      expect(mdToDoc(md)).toEqual(doc)
      // and saving again changes nothing
      expect(docToMd(mdToDoc(md))).toBe(md)
    })
  }
  it('keeps blank lines between paragraphs', () => {
    const doc = { type: 'doc', content: [p('one'), { type: 'paragraph' }, { type: 'paragraph' }, p('two'), { type: 'paragraph' }] }
    expect(mdToDoc(docToMd(doc))).toEqual(doc)
    expect(docToMd(doc)).toBe('one\n\n\ntwo\n')
  })
  it('holds an unfinished list marker until its text arrives, without changing saved literal text', () => {
    for (const marker of ['-', '*', '+', '1.', '2)', '  - ']) {
      const md = `Plan\n${marker}`
      expect(mdToDoc(md, { streaming: true })).toEqual(mdToDoc('Plan'))
      expect(JSON.stringify(mdToDoc(md))).toContain(marker.trim())
      expect(mdToDoc(`${md} Send it`, { streaming: true }).content!.at(-1)!.type).toMatch(/List$/)
    }
    expect(mdToDoc('Plan\n-\nDone', { streaming: true }).content).toHaveLength(3)
  })
  it('while streaming, opens no empty block for a blank line or a bare heading marker', () => {
    for (const tail of ['\n', '\n\n', ' ', '\n\n#', '\n\n## ', '\n###'])
      expect(mdToDoc(`Plan${tail}`, { streaming: true })).toEqual(mdToDoc('Plan'))
    expect(mdToDoc('Plan\n\n## Next', { streaming: true }).content!.at(-1)!.type).toBe('heading')
    expect(mdToDoc('Plan\n\n')).not.toEqual(mdToDoc('Plan'))
  })
  it('while streaming, a block at the end with no text yet waits for its text', () => {
    for (const tail of ['\n- **', '\n## **', '\n- [', '\n- <mi'])
      expect(mdToDoc(`Plan${tail}`, { streaming: true })).toEqual(mdToDoc('Plan'))
    expect(mdToDoc('- one\n  - **', { streaming: true })).toEqual(mdToDoc('- one'))
    expect(mdToDoc('- one\n- **Chr', { streaming: true }).content![0].content).toHaveLength(2)
    expect(mdToDoc('**', { streaming: true })).toEqual(mdToDoc(''))
  })

  it('while streaming, a mark still open runs to the end and a half-written tag is hidden', () => {
    const doc = mdToDoc('- **Maya', { streaming: true })
    expect(doc.content![0].content![0].content![0].content).toEqual([{ type: 'text', text: 'Maya', marks: [{ type: 'bold' }] }])
    const doc2 = mdToDoc('- done <mi', { streaming: true })
    expect(doc2.content![0].content![0].content![0].content).toEqual([{ type: 'text', text: 'done ' }])
  })
})

it('opts into literal inline code for answer previews, leaving editor parsing unchanged', () => {
  const md = 'Use `a * b` and ``a`b``.'
  const doc = mdToDoc(md, { inlineCode: true })
  expect(doc.content![0].content).toContainEqual({ type: 'text', text: 'a * b', marks: [{ type: 'code' }] })
  expect(docToMd(doc)).toBe(md)
  expect(JSON.stringify(mdToDoc(md))).not.toContain('"type":"code"')
  expect(mdToDoc('Use `send', { inlineCode: true, streaming: true }).content![0].content!.at(-1)).toMatchObject({ text: 'send', marks: [{ type: 'code' }] })
})
