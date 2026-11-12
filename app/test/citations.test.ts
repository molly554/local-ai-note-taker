import { describe, expect, it } from 'vitest'
import type { PMNode } from '../src/shared/markdown'
import { citationPassage, citationTargetIndex, citationExcerptLines, citationExcerptText, citationDoc, citedIn, tidyCitations } from '../src/shared/citations'

/** sources numbered from 1, one letter per source naming its meeting: 'aab' is two parts of a, then b */
const of = (meetings: string) => [...meetings].map((meetingId, i) => ({ n: i + 1, meetingId }))

describe('citations in an answer', () => {
  it('reads [1], [1, 2] and [1][2]', () => {
    expect(citedIn('Twenty dollars [1]. Live Tuesday [2, 3]. Also [1][3].')).toEqual([1, 2, 3])
  })
  it('takes out numbers that were never given', () => {
    expect(tidyCitations('Twenty dollars [1]. Live [4]. Both [1, 4].', of('ab'))).toBe('Twenty dollars [1]. Live. Both [1].')
  })
  it('cites a meeting once where several of its parts are cited together', () => {
    expect(tidyCitations('It came up [1][2] [3, 4].', of('aaab'))).toBe('It came up [1, 4].')
    expect(tidyCitations('- With Dana [2] [3] [4] [5] [6]\n- Other [1]', of('baaaaa'))).toBe('- With Dana [2]\n- Other [1]')
  })
  it('drops a pile that cites most of the meetings at once: that points at nothing in particular', () => {
    expect(tidyCitations('Nothing here is about politics [1][2][3][4][5][6].', of('abcdefgh'))).toBe('Nothing here is about politics.')
    expect(tidyCitations('No word of it [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].', of('aabbccddee'))).toBe('No word of it.')
  })
  it('keeps a few meetings cited together', () => {
    expect(tidyCitations('Two calls [1, 3].', of('abcdefgh'))).toBe('Two calls [1, 3].')
    expect(tidyCitations('All three [1, 2, 3].', of('abc'))).toBe('All three [1, 2, 3].')
  })
  it('gives the same text when tidied again', () => {
    const once = tidyCitations('It came up [1][2] [3, 4]. Gone [1][2][3][4][5][6][7].', of('aaabcdef'))
    expect(tidyCitations(once, of('aaabcdef'))).toBe(once)
  })
})

const citationNodes = (node: PMNode): PMNode[] => node.type === 'citation' ? [node] : (node.content ?? []).flatMap(citationNodes)
const marks = (answer: string, sources = of('aab'), live = false) => citationNodes(citationDoc(answer, sources, live)).flatMap(n => n.attrs!.marks)

describe('numbered citation Markdown', () => {
  it('numbers meetings by first appearance, reusing the number but keeping the specific chunk', () => {
    expect(marks('First [3]. Next [2]. Another part [1].')).toEqual([
      { source: 3, number: 1 }, { source: 2, number: 2 }, { source: 1, number: 2 },
    ])
    expect(marks('A new answer [1].')).toEqual([{ source: 1, number: 1 }])
  })
  it('groups adjacent marks, filters unknown IDs and preserves Markdown structure and emphasis', () => {
    const doc = citationDoc('## Decision\n- **Ship** [3][1][2][99].\n- *Wait* [2].', of('aab'))
    expect(doc.content?.map(n => n.type)).toEqual(['heading', 'bulletList'])
    const paragraph = doc.content![1].content![0].content![0]
    expect(paragraph.content![0].content![0]).toMatchObject({ type: 'text', text: 'Ship', marks: [{ type: 'bold' }] })
    expect(citationNodes(doc).map(n => n.attrs!.marks)).toEqual([
      [{ source: 3, number: 1 }, { source: 1, number: 2 }], [{ source: 2, number: 2 }],
    ])
    expect(JSON.stringify(doc)).not.toContain('[99]')
    expect(doc.content).toHaveLength(2) // no appended footnote list
  })
  it('binds the whole preceding word and punctuation across Markdown spans', () => {
    for (const live of [false, true]) {
      const doc = citationDoc('Lincoln announces it **Wednes**day [1][2].', of('ab'), live)
      const anchor = doc.content![0].content!.at(-1)!
      expect(anchor.type).toBe('citationAnchor')
      expect(anchor.content!.slice(0, -1).map(n => n.text).join('')).toBe('Wednesday.')
      expect(anchor.content![0].marks).toEqual([{ type: 'bold' }])
      expect(citationNodes(anchor)[0].attrs!.marks).toHaveLength(2)
    }
  })
  it('keeps earlier numbers while streaming, waits for an incomplete mark, and matches the saved result', () => {
    const prefix = 'First [3]. Next [2].'
    expect(marks(prefix + ' And [1', of('aab'), true)).toEqual(marks(prefix))
    expect(marks(prefix + ' And [1].', of('aab'), true)).toEqual([...marks(prefix), { source: 1, number: 2 }])
    expect(citationDoc(prefix, of('aab'), true)).toEqual(citationDoc(prefix, of('aab')))
  })
})

const visible = (answer: string, live = false): string => {
  const text = (node: PMNode): string => node.type === 'citation'
    ? (node.attrs!.marks as Array<{ number: number }>).map(m => `[${m.number}]`).join(' ')
    : node.text ?? (node.content ?? []).map(text).join('')
  return text(citationDoc(answer, of('abc'), live))
}

describe('citation punctuation and streamed placement', () => {
  it.each([
    ['Voice volume [1] .', 'Voice volume.[1]'],
    ['Ship [1]!', 'Ship![1]'],
    ['Ready [1]?', 'Ready?[1]'],
    ['Already done. [1]', 'Already done.[1]'],
    ['He said “Ship [1].”', 'He said “Ship.”[1]'],
    ['He said “Ship.” [1]', 'He said “Ship.”[1]'],
    ['He said "Ship [1]".', 'He said "Ship".[1]'],
    ['It works (with speakers [1]).', 'It works (with speakers).[1]'],
    ['It works (with speakers.) [1]', 'It works (with speakers.)[1]'],
    ['The answer (yes [1])', 'The answer (yes)[1]'],
    ['Two sources [1][2].', 'Two sources.[1] [2]'],
    ['**Ship [1]**.', 'Ship.[1]'],
    ['**Ship** [1]*.*', 'Ship.[1]'],
    ['**One** [1], *another* [2] and a third.', 'One[1], another[2] and a third.'],
    ['The rate [1] is 1.25 dollars.', 'The rate[1] is 1.25 dollars.'],
  ])('places %s without added spaces', (answer, expected) => {
    expect(visible(answer)).toBe(expected)
  })
  it.each([
    ['Done [1].', false], ['Go! [1]', false], ['Ready? [1]', false],
    ['“Done.” [1]', false], ['(Done) [1]', false],
    ['A decision [1]', true], ['November 6, 2026 [1]', true],
    ['**café** [1]', true], ['Cafe\u0301 [1]', true],
  ])('sets the visual gap for %s without changing the text', (answer, gap) => {
    expect(citationNodes(citationDoc(answer, of('a')))[0].attrs!.gap).toBe(gap)
  })
  it('adds a gap to unpunctuated bullets without inventing punctuation', () => {
    expect(visible('- November 6, 2026 [1]')).toBe('November 6, 2026[1]')
    expect(citationNodes(citationDoc('- November 6, 2026 [1]', of('a')))[0].attrs!.gap).toBe(true)
    expect(citationNodes(citationDoc('- November 6, 2026 [1]', of('a'), true))).toEqual([])
    expect(citationNodes(citationDoc('- November 6, 2026 [1].', of('a'), true))[0].attrs!.gap).toBe(false)
  })
  it('waits at every incomplete citation and punctuation boundary, then matches the saved answer', () => {
    for (const tail of ['[', '[1', '[1]', '[1] ', '[1] [2', '[1][2]']) {
      expect(visible('Voice volume ' + tail, true)).toBe('Voice volume')
    }
    expect(visible('Voice volume [1].', true)).toBe('Voice volume.[1]')
    expect(visible('Voice volume [1]. Next', true)).toBe('Voice volume.[1] Next')
    expect(visible('Voice volume [1] Next sentence', true)).toBe('Voice volume[1] Next sentence')
    expect(visible('First [1]\nNext sentence', true)).toBe('First[1]Next sentence')
    expect(visible('A claim [1] continues', true)).toBe('A claim continues')
    expect(visible('A claim [1] costs 1.25', true)).toBe('A claim costs 1.25')
    expect(visible('A claim [1] continues.', true)).toBe('A claim[1] continues.')
    expect(visible('A claim [1] continues.', true)).toBe(visible('A claim [1] continues.'))
  })
  it('preserves punctuation formatting and numbers when a held citation is released', () => {
    const doc = citationDoc('**Ship [3]**. Next [1]', of('abc'), true)
    expect(citationNodes(doc).map(n => n.attrs!.marks)).toEqual([[{ source: 3, number: 1 }]])
    expect(doc.content![0].content![0].content!.find(n => n.text === '.')).toEqual({ type: 'text', text: '.' })
    expect(marks('**Ship [3]**. Next [1].', of('abc'), true)).toEqual([{ source: 3, number: 1 }, { source: 1, number: 2 }])
  })
})

describe('citation excerpts', () => {
  const excerpt = '## Decisions\n- **Jamie:** ship *Tuesday* with `send_email` and [the plan](https://example.com).\n\n#### Next steps\n1. Send the invite.'
  it('keeps inline formatting but removes heading and list syntax from notes', () => {
    const lines = citationExcerptLines(excerpt)
    expect(lines[0]).toEqual([{ type: 'text', text: 'Decisions' }])
    expect(lines[1]).toContainEqual({ type: 'text', text: 'Jamie:', marks: [{ type: 'bold' }] })
    expect(lines[1]).toContainEqual({ type: 'text', text: 'Tuesday', marks: [{ type: 'italic' }] })
    expect(lines[1]).toContainEqual({ type: 'text', text: 'send_email', marks: [{ type: 'code' }] })
    expect(lines[3]).toEqual([{ type: 'text', text: 'Next steps' }])
  })
  it('strips formatting for transcript excerpts without deleting the words or line breaks', () => {
    expect(citationExcerptText(excerpt)).toBe('Decisions\nJamie: ship Tuesday with send_email and the plan.\n\nNext steps\nSend the invite.')
    expect(citationExcerptText('You: Keep C# and snake_case; use ``a`b``.')).toBe('You: Keep C# and snake_case; use a`b.')
    expect(citationExcerptText('')).toBe('')
  })
})

describe('citation passages', () => {
  it('uses each mark’s own answer sentence, including a mid-clause mark and formatted words', () => {
    const doc = citationDoc('**Pricing** is twenty dollars [1]. The launch [1] is Tuesday. Ship it [1]!', of('a'))
    expect(citationNodes(doc).map(n => n.attrs!.sentence)).toEqual(['Pricing is twenty dollars.', 'The launch is Tuesday.', 'Ship it!'])
  })
  it('quotes the highest distinct token overlap with one sentence of context on either side', () => {
    expect(citationPassage('## Purpose\nWe reviewed the launch. **Pricing is twenty dollars a seat.** Discounts apply to annual plans. Ship Tuesday.', 'Seats cost twenty dollars.')).toEqual({
      before: 'We reviewed the launch.', match: 'Pricing is twenty dollars a seat.', after: 'Discounts apply to annual plans.',
    })
  })
  it('uses lines for speaker turns, removes Markdown and keeps source wording', () => {
    expect(citationPassage('Maya: We should wait\nLee: The **launch** is Tuesday\nMaya: Send invitations', 'Launch Tuesday.')).toEqual({
      before: 'Maya: We should wait', match: 'Lee: The launch is Tuesday', after: 'Maya: Send invitations',
    })
  })
  it('handles Unicode, repeated words, ties, empty excerpts and no overlap deterministically', () => {
    expect(citationPassage('Launch launch launch. Launch pricing.', 'Launch pricing.').match).toBe('Launch pricing.')
    expect(citationPassage('Le café ouvre lundi. Le café ferme mardi.', 'Café mardi.').match).toBe('Le café ferme mardi.')
    expect(citationPassage('First. Next.', 'No overlap.')).toEqual({ before: '', match: 'First.', after: 'Next.' })
    expect(citationPassage('', 'Anything.')).toEqual({ before: '', match: '', after: '' })
  })
  it('finds the matching source block without punctuation, Markdown or speaker-prefix differences', () => {
    expect(citationTargetIndex(['Purpose', 'Price is **twenty dollars**. No discounts.'], 'Price is twenty dollars.')).toBe(1)
    expect(citationTargetIndex(['Other text.', 'The launch is Tuesday.'], 'Lee: The launch is Tuesday.')).toBe(1)
    expect(citationTargetIndex(['Earlier. The launch is', 'Tuesday. More details.'], 'Lee: The launch is Tuesday.')).toBe(0)
    expect(citationTargetIndex(['Ship Tuesday.', 'Other text.', 'Ship Tuesday.'], 'Ship Tuesday.', 2)).toBe(2)
    expect(citationTargetIndex(['Changed source.'], 'The launch is Tuesday.')).toBe(-1)
    expect(citationTargetIndex([''], '')).toBe(-1)
  })
})
