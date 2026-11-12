import { describe, expect, it } from 'vitest'
import { nameFor, othersIn, type CallSample } from '../src/main/callNames/attribute'

/** a reading every 500 ms from `from` to `to` (meeting time), all saying the same */
const run = (from: number, to: number, s: Partial<CallSample>): CallSample[] =>
  Array.from({ length: Math.floor((to - from) / 500) }, (_, i) => ({ ms: from + i * 500, speaking: [], participants: [], me: null, ...s }))

const group = ['Alex Morgan', 'Dana Smith', 'Ann Lee']
const meetingOf3 = { participants: group, me: 'Alex Morgan' }

describe('nameFor: who the other side was, from what the call app showed', () => {
  it('names the person marked as talking for the whole line', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })
    expect(nameFor({ startMs: 2000, endMs: 6000 }, tl)).toBe('Dana Smith')
  })

  it('takes the one who talked for most of the line', () => {
    const tl = [...run(0, 3000, { ...meetingOf3, speaking: ['Ann Lee'] }), ...run(3000, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })]
    expect(nameFor({ startMs: 2000, endMs: 7000 }, tl)).toBe('Dana Smith')
  })

  it('is Them when nobody has most of it', () => {
    const tl = [...run(0, 4000, { ...meetingOf3, speaking: ['Ann Lee'] }), ...run(4000, 6000, meetingOf3), ...run(6000, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] })]
    expect(nameFor({ startMs: 2000, endMs: 8000 }, tl)).toBeNull()
  })

  it('is Them when two people are marked at once', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Ann Lee', 'Dana Smith'] })
    expect(nameFor({ startMs: 1000, endMs: 5000 }, tl)).toBeNull()
  })

  it('is Them when only the person using Yogurt is marked (their own voice, not the other side)', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Alex Morgan'] })
    expect(nameFor({ startMs: 1000, endMs: 5000 }, tl)).toBeNull()
    // and when they are told apart only by the name in Settings
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: group, speaking: ['Alex Morgan'] }), { myNames: ['alex morgan'] })).toBeNull()
  })

  it('is Them with no readings, or readings that stopped long before the line', () => {
    expect(nameFor({ startMs: 1000, endMs: 5000 }, [])).toBeNull()
    // a reading counts for 2 s at most: a stuck app never keeps naming someone
    const tl = run(0, 1000, { ...meetingOf3, speaking: ['Dana Smith'] })
    expect(nameFor({ startMs: 4000, endMs: 8000 }, tl)).toBeNull()
  })

  it('a reading where the app could not be read counts as not knowing', () => {
    const tl = [...run(0, 2000, { ...meetingOf3, speaking: ['Dana Smith'] }), ...run(2000, 10_000, { ok: false })]
    expect(nameFor({ startMs: 0, endMs: 6000 }, tl)).toBeNull()
  })

  it('in a call with one other person, every line of the other side is theirs, marked or not', () => {
    const pair = { participants: ['Alex Morgan', 'Dana Smith'], me: 'Alex Morgan' }
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, pair))).toBe('Dana Smith')
    // the app marking the person themself changes nothing: the call's sound can only be the other person
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { ...pair, speaking: ['Alex Morgan'] }))).toBe('Dana Smith')
  })

  it('a call of two where nobody is known to be the person using Yogurt names nobody', () => {
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: ['Ann Lee', 'Dana Smith'] }))).toBeNull()
    // the name in Settings tells them apart
    expect(nameFor({ startMs: 1000, endMs: 5000 }, run(0, 10_000, { participants: ['Ann Lee', 'Dana Smith'] }), { myNames: ['Ann  Lee'] })).toBe('Dana Smith')
  })

  it('a very short line is named by the moment it starts', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Ann Lee'] })
    expect(nameFor({ startMs: 3000, endMs: 3000 }, tl)).toBe('Ann Lee')
  })

  it('readings out of order are sorted first', () => {
    const tl = run(0, 10_000, { ...meetingOf3, speaking: ['Dana Smith'] }).reverse()
    expect(nameFor({ startMs: 2000, endMs: 6000 }, tl)).toBe('Dana Smith')
  })
})

describe('othersIn: everyone seen in the call but the person using Yogurt', () => {
  it('lists each other name once, in the order first seen', () => {
    const tl = [...run(0, 1000, meetingOf3), ...run(1000, 2000, { participants: ['Alex Morgan', 'Bo Park', 'Dana Smith'], me: 'Alex Morgan', speaking: ['Bo Park'] })]
    expect(othersIn(tl)).toEqual(['Dana Smith', 'Ann Lee', 'Bo Park'])
    expect(othersIn(run(0, 1000, { participants: ['Alex Morgan', 'Dana Smith'] }), { myNames: ['Alex Morgan'] })).toEqual(['Dana Smith'])
  })
})
