import { describe, expect, it } from 'vitest'
import { fileNameFor, shareTarget, toClipboard, toMarkdownFile, toPlainText, transcriptDoc } from '../src/shared/exportNotes'
import { docToMd } from '../src/shared/markdown'
import type { Meeting, Segment } from '../src/shared/types'

const md = '## Plan\n- **Maya:** send it\n  - *soon*, see [doc](https://x.io)\n- <mine>my own line</mine>\n1. first\n2. second'

describe('toPlainText', () => {
  it('puts bullets as dots, nested ones indented, headings on their own lines, and drops the styling', () => {
    expect(toPlainText(md)).toBe('Plan\n• Maya: send it\n  • soon, see doc (https://x.io)\n• my own line\n1. first\n2. second')
  })
  it('keeps blank lines between paragraphs', () => {
    expect(toPlainText('one\n\ntwo')).toBe('one\n\ntwo')
  })
})

describe('toClipboard', () => {
  const { text, html } = toClipboard(md)
  it('gives the plain text next to the HTML', () => expect(text).toBe(toPlainText(md)))
  it('writes simple semantic tags with nested lists and no classes or styles', () => {
    expect(html).toContain('<h2>Plan</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li><strong>Maya:</strong> send it<ul><li><em>soon</em>, see <a href="https://x.io">doc</a></li></ul></li>')
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>')
    expect(html).not.toMatch(/class=|style=|mine/)
  })
  it('escapes what the notes contain', () => {
    const out = toClipboard('a <b>bold</b> & "q"\n- 1 < 2').html
    expect(out).toContain('<p>a &lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot;</p>')
    expect(out).toContain('<li>1 &lt; 2</li>')
  })
  it('does not link anything but web and mail addresses', () => {
    expect(toClipboard('[x](javascript:run)').html).toBe('<p>x</p>')
  })
})

const meeting: Meeting = {
  id: 'm1', title: 'Weekly sync', startedAt: new Date(2026, 9, 29, 10, 30).getTime(), endedAt: null, eventId: null, app: null,
  attendees: [{ name: 'Maya Chen', email: null }, { name: 'Sam', email: 's@x.io' }], state: 'done', language: null, titleSource: 'user',
}
const seg = (track: 'me' | 'them', startMs: number, text: string, speaker: string | null = null): Segment => ({ id: startMs, meetingId: 'm1', track, startMs, endMs: startMs + 2000, text, speaker })
const segments = [seg('me', 0, 'Hi all.'), seg('me', 3000, 'Starting now.'), seg('them', 6000, 'Hello *there*', 'Maya'), seg('them', 70_000, 'Hm.')]

describe('toMarkdownFile', () => {
  const file = toMarkdownFile(meeting, '## Plan\n- <mine>ship</mine>', segments)
  it('has the title, date, people, notes and transcript in that order', () => {
    const at = ['# Weekly sync', '2026', 'Maya Chen, Sam', '## Plan', '- ship', '## Transcript'].map((s) => file.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
  it('keeps the person\'s own words as plain text', () => expect(file).not.toContain('<mine>'))
  it('gives each turn a name and time: You, the name from the call, or Them', () => {
    expect(file).toContain('**You** (0:00)\n\nHi all. Starting now.')
    expect(file).toContain('**Maya** (0:06)\n\nHello \\*there\\*')
    expect(file).toContain('**Them** (1:10)\n\nHm.')
  })
  it('leaves out the transcript section when nothing was heard', () => expect(toMarkdownFile(meeting, 'x', [])).not.toContain('Transcript'))
})

describe('transcriptDoc', () => {
  it('copies as plain turns', () => {
    expect(toPlainText(docToMd(transcriptDoc(segments.slice(0, 3))))).toBe('You (0:00)\nHi all. Starting now.\n\nMaya (0:06)\nHello *there*')
  })
})

describe('fileNameFor', () => {
  it('is the title and day, without characters a file name cannot hold', () => {
    expect(fileNameFor('Q3 / plan: "draft"?', new Date(2026, 9, 29).getTime())).toBe('Q3 plan draft 2026-10-29.md')
    expect(fileNameFor('   ', new Date(2026, 9, 5).getTime())).toBe('Meeting 2026-10-05.md')
    expect(fileNameFor('.hidden..', new Date(2026, 9, 5).getTime())).toBe('hidden 2026-10-05.md')
    expect(fileNameFor('x'.repeat(300), 0).length).toBeLessThan(120)
  })
})

describe('more shapes', () => {
  it('maps heading levels 1 and 2 to h2 and 3 to h3', () => {
    const { html } = toClipboard('# One\n## Two\n### Three')
    expect(html).toBe('<h2>One</h2><h2>Two</h2><h3>Three</h3>')
  })
  it('nests numbered lists', () => {
    const md = '1. a\n   1. b\n   2. c\n2. d'
    expect(toPlainText(md)).toBe('1. a\n  1. b\n  2. c\n2. d')
    expect(toClipboard(md).html).toBe('<ol><li>a<ol><li>b</li><li>c</li></ol></li><li>d</li></ol>')
  })
  it('gives nothing for empty notes', () => {
    expect(toClipboard('').text).toBe('')
    expect(toClipboard('  \n ').text.trim()).toBe('')
  })
  it('puts the title in the file as typed, with Markdown characters made literal', () => {
    expect(toMarkdownFile({ ...meeting, title: 'Q3 *plan* [x]' }, 'n', []).startsWith('# Q3 \\*plan\\* \\[x\\]\n')).toBe(true)
  })
  it('lists the people as one text', () => expect(toMarkdownFile(meeting, 'n', [])).toContain('With: Maya Chen, Sam'))
  it('cuts a long name at a whole character', () => {
    const name = fileNameFor('😀'.repeat(200), 0)
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('shareTarget: what is copied is what is shown', () => {
  it('copies My notes on that tab', () => expect(shareTarget('mine', 'writing')).toEqual({ side: 'mine', writing: false, fellBack: false }))
  it('waits while the notes are being written', () => {
    for (const st of ['waiting', 'writing'] as const) expect(shareTarget('enhanced', st)).toEqual({ side: 'enhanced', writing: true, fellBack: false })
  })
  it('falls back to My notes, and says so, when writing failed or there was nothing', () => {
    for (const st of ['failed', 'empty'] as const) expect(shareTarget('enhanced', st)).toEqual({ side: 'mine', writing: false, fellBack: true })
  })
  it('copies the enhanced notes when they are done', () => expect(shareTarget('enhanced', 'done')).toEqual({ side: 'enhanced', writing: false, fellBack: false }))
  it('keeps a previous Enhanced result as the copy/export target when its rewrite failed', () => {
    expect(shareTarget('enhanced', 'failed', true)).toEqual({ side: 'enhanced', writing: false, fellBack: false })
  })
})
