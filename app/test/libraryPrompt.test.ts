import { describe, expect, it } from 'vitest'
import { byMeeting, libraryHead, libraryPrompt, meetingLabel, sourceLabel } from '../src/main/library/prompt'

const at = new Date(2026, 10, 3, 10, 0).getTime()
const items = [
  { meetingId: 'a', title: 'Pricing call', startedAt: at, atMs: 724_000, text: 'Tarun Shah: Twenty dollars a seat.' },
  { meetingId: 'b', title: 'Weekly sync', startedAt: at - 9 * 86_400_000, atMs: null, text: '## Launch\n- Live on Tuesday.' },
]

describe('the prompt for chat across meetings', () => {
  it('starts with the same instructions every time (the model keeps them read), then the numbered sources, then the question', () => {
    const p = libraryPrompt({ items, question: 'What did Tarun say?', history: [], now: at, spelling: '' })
    expect(p.startsWith(libraryHead)).toBe(true)
    const p2 = libraryPrompt({ items: [], question: 'Other?', history: [], now: at + 86_400_000, spelling: 'x' })
    expect(p2.startsWith(libraryHead)).toBe(true)
    expect(p.indexOf('Meeting: Pricing call')).toBeLessThan(p.indexOf('[1] 12:04'))
    expect(p.indexOf('[1] 12:04')).toBeLessThan(p.indexOf('Meeting: Weekly sync'))
    expect(p.indexOf('Meeting: Weekly sync')).toBeLessThan(p.indexOf('[2] the meeting notes'))
    expect(p).toContain('Tarun Shah: Twenty dollars a seat.')
    expect(p.trimEnd().endsWith('<question>\nWhat did Tarun say?\n</question>')).toBe(true)
    expect(p).toContain('Today is Tuesday, November 3, 2026.')
  })
  it('heads each meeting with its title and day, and labels each source with where in it (or that it is the notes)', () => {
    expect(meetingLabel(items[0])).toBe('Meeting: Pricing call · Tuesday, November 3, 2026')
    expect(sourceLabel(items[0], 1)).toBe('[1] 12:04 into the meeting')
    expect(sourceLabel(items[1], 2)).toBe('[2] the meeting notes')
  })
  it('lists the parts of one meeting under one heading and says how many meetings there are, so they are counted as meetings', () => {
    const more = [...items, { ...items[0], atMs: 100_000, text: 'You: Hello.' }]
    const p = libraryPrompt({ items: byMeeting(more), question: 'q', history: [], now: at, spelling: '' })
    expect(p.match(/^Meeting: Pricing call/gm)).toHaveLength(1)
    expect(p.indexOf('[1] 1:40')).toBeLessThan(p.indexOf('[2] 12:04'))
    expect(p.indexOf('[2] 12:04')).toBeLessThan(p.indexOf('Meeting: Weekly sync'))
    expect(p).toContain('These come from 2 meetings.')
    expect(libraryPrompt({ items: [items[0]], question: 'q', history: [], now: at, spelling: '' })).toContain('These come from 1 meeting.')
  })
  it('groups the sources by meeting, best meeting first, each meeting\'s parts in the order they were said', () => {
    const a = (atMs: number | null) => ({ ...items[0], atMs })
    const b = (atMs: number | null) => ({ ...items[1], atMs })
    expect(byMeeting([a(500), b(9), a(100), b(null), a(300)]).map((i) => [i.meetingId, i.atMs])).toEqual([['a', 100], ['a', 300], ['a', 500], ['b', null], ['b', 9]])
  })
  it('says plainly when nothing was found, and carries earlier turns without their citations', () => {
    const p = libraryPrompt({ items: [], question: 'And then?', history: [{ question: 'Price?', answer: 'Twenty dollars [1].' }], now: at, spelling: '' })
    expect(p).toContain('No meetings matched this question.')
    expect(p).toContain('<answered>\nTwenty dollars.\n</answered>')
  })
})

