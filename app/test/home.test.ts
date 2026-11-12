import { describe, expect, it } from 'vitest'
import { pickNext } from '../src/shared/comingUp'
import { loadUpTo } from '../src/renderer/src/paging'
import type { CalEvent } from '../src/shared/types'

const MIN = 60_000
const ev = (id: string, start: number, end: number): CalEvent => ({ id, title: id, start, end, attendees: [], url: null })

describe('pickNext', () => {
  const now = 1_000 * MIN
  it('picks the one about to start over a long one already running', () => {
    expect(pickNext([ev('allday', now - 120 * MIN, now + 240 * MIN), ev('soon', now + 5 * MIN, now + 35 * MIN)], now)).toBe('soon')
  })
  it('picks the one that just started over one running for a while', () => {
    expect(pickNext([ev('old', now - 50 * MIN, now + 10 * MIN), ev('new', now - 2 * MIN, now + 28 * MIN)], now)).toBe('new')
  })
  it('picks the soonest of those starting', () => {
    expect(pickNext([ev('b', now + 12 * MIN, now + 40 * MIN), ev('a', now + 3 * MIN, now + 30 * MIN)], now)).toBe('a')
  })
  it('none when nothing starts within 15 minutes or is on', () => {
    expect(pickNext([ev('later', now + 40 * MIN, now + 70 * MIN)], now)).toBeUndefined()
  })
})

describe('loadUpTo', () => {
  type C = { id: string; startedAt: number }
  const all: C[] = Array.from({ length: 1234 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}`, startedAt: 10_000 - i }))
  // like main: newest first, at most 1000 a call
  const fetch = async ({ before, limit }: { before?: { at: number; id: string }; limit: number }) => {
    const from = before ? all.findIndex((c) => c.startedAt < before.at) : 0
    return all.slice(from, from + Math.min(limit, 1000))
  }
  it('loads past the cap of one call, in order, and says when more remain', async () => {
    const r = await loadUpTo(fetch, 1100, 40)
    expect(r.cards.map((c) => c.id)).toEqual(all.slice(0, 1100).map((c) => c.id))
    expect(r.more).toBe(true)
  })
  it('loads at least a page, and says when the end was reached', async () => {
    const r = await loadUpTo(fetch, 0, 40)
    expect(r.cards).toHaveLength(40)
    const end = await loadUpTo(fetch, 5000, 40)
    expect(end.cards).toHaveLength(1234)
    expect(end.more).toBe(false)
  })
})
