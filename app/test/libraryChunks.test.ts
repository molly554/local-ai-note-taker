import { describe, expect, it } from 'vitest'
import { chunkTranscript, CHUNK_WORDS } from '../src/main/library/chunks'
import type { Segment } from '../src/main/store'

let next = 1
const line = (track: 'me' | 'them', startMs: number, text: string, speaker: string | null = null): Segment =>
  ({ id: next++, meetingId: 'm', track, startMs, endMs: startMs + 900, text, speaker })
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ')

describe('cutting a transcript into chunks', () => {
  it('keeps a short meeting whole, written the way the notes read it, with who spoke and when', () => {
    const c = chunkTranscript([line('me', 0, 'Hello there.'), line('them', 1000, 'Hi, the price is 20 dollars.', 'Tarun Shah'), line('them', 2000, 'Per seat.', 'Tarun Shah')])
    expect(c).toEqual([{ startMs: 0, endMs: 2900, text: 'You: Hello there.\nTarun Shah: Hi, the price is 20 dollars. Per seat.', speakers: ['You', 'Tarun Shah'] }])
  })

  it('cuts at a change of speaker once a chunk has about 300 words, never inside a turn that fits', () => {
    const segs = Array.from({ length: 12 }, (_, i) => line(i % 2 ? 'them' : 'me', i * 10_000, words(60, `w${i}`)))
    const c = chunkTranscript(segs)
    expect(c.length).toBeGreaterThan(1)
    for (const x of c) {
      const n = x.text.split(/\s+/).filter((w) => !w.endsWith(':')).length
      expect(n).toBeLessThanOrEqual(CHUNK_WORDS + 60)
      // every turn starts a line
      for (const l of x.text.split('\n')) expect(l).toMatch(/^(You|Them): /)
    }
    // nothing lost, in order, and the times line up
    expect(c.map((x) => x.text).join('\n').split('\n')).toHaveLength(12)
    expect(c[0].startMs).toBe(0)
    expect(c.at(-1)!.endMs).toBe(110_900)
    for (let i = 1; i < c.length; i++) expect(c[i].startMs).toBeGreaterThan(c[i - 1].endMs - 1)
  })

  it('splits one long monologue at its lines', () => {
    const segs = Array.from({ length: 10 }, (_, i) => line('them', i * 10_000, words(80), 'Ann Lee'))
    const c = chunkTranscript(segs)
    expect(c.length).toBeGreaterThan(2)
    for (const x of c) expect(x.text.startsWith('Ann Lee: ')).toBe(true)
    expect(c.map((x) => x.speakers)).toEqual(c.map(() => ['Ann Lee']))
  })

  it('has no chunks for a meeting with no lines', () => {
    expect(chunkTranscript([])).toEqual([])
  })
})
