import { describe, expect, it } from 'vitest'
import { chunker, type Chunk } from '../src/main/asr/chunker'

const RATE = 16000
const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => amp * Math.sin(i / 10))
const quiet = (sec: number) => new Float32Array(Math.round(sec * RATE))
const cat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
/** feeds samples the way capture does: 100 ms frames on meeting time */
function feed(push: (t: 'me' | 'them', ms: number, s: Float32Array) => void, track: 'me' | 'them', all: Float32Array, startMs = 0) {
  const step = RATE / 10
  for (let i = 0; i < all.length; i += step) push(track, startMs + i / 16, all.subarray(i, i + step))
}
const run = (all: Float32Array, track: 'me' | 'them' = 'me') => {
  const out: Chunk[] = []
  const c = chunker((x) => out.push(x))
  feed(c.push, track, all)
  c.flush()
  return out
}
const secs = (c: Chunk) => c.samples.length / RATE

describe('chunker', () => {
  it('3 s of tone, 1 s of silence, 2 s of tone make two chunks at the right times', () => {
    const out = run(cat(tone(3), quiet(1), tone(2)))
    expect(out).toHaveLength(2)
    expect(out[0].startMs).toBe(0)
    expect(out[1].startMs).toBe(4000)
    expect(secs(out[0])).toBeGreaterThanOrEqual(3)
    expect(secs(out[0])).toBeLessThan(3.5)
    expect(secs(out[1])).toBeGreaterThanOrEqual(2)
  })

  it('drops leading silence and starts the chunk where the voice starts', () => {
    const out = run(cat(quiet(2), tone(1.5)))
    expect(out).toHaveLength(1)
    expect(out[0].startMs).toBe(2000)
  })

  it('does not split on a pause shorter than 600 ms', () => {
    expect(run(cat(tone(2), quiet(0.4), tone(2)))).toHaveLength(1)
  })

  it('40 s of nonstop tone gives chunks of 15 s or less that cover it all', () => {
    const out = run(tone(40))
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const c of out) expect(secs(c)).toBeLessThanOrEqual(15)
    expect(out.reduce((n, c) => n + c.samples.length, 0)).toBe(40 * RATE)
    // chunks follow each other with nothing lost between
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBe(out[i - 1].startMs + secs(out[i - 1]) * 1000)
  })

  it('cuts a long run at the quietest 100 ms in the last 2 seconds', () => {
    // 20 s of tone with one dip at 13.45 s: the 15 s cap must cut there
    const all = tone(20)
    all.fill(0.01, 13.4 * RATE, 13.5 * RATE)
    const out = run(all)
    expect(out[0].startMs).toBe(0)
    expect(secs(out[0])).toBeCloseTo(13.5, 1)
  })

  it('keeps the tracks apart', () => {
    const out: Chunk[] = []
    const c = chunker((x) => out.push(x))
    feed(c.push, 'me', cat(tone(1), quiet(1)))
    feed(c.push, 'them', cat(quiet(1), tone(1)), 0)
    c.flush()
    expect(out.map((x) => [x.track, x.startMs])).toEqual(expect.arrayContaining([['me', 0], ['them', 1000]]))
    expect(out).toHaveLength(2)
  })

  it('ignores a click too short to be speech', () => {
    expect(run(cat(quiet(1), tone(0.1), quiet(2)))).toHaveLength(0)
  })

  it('starts fresh after a gap in meeting time (a pause or a recorder restart)', () => {
    const out: Chunk[] = []
    const c = chunker((x) => out.push(x))
    feed(c.push, 'me', tone(2), 0)
    feed(c.push, 'me', tone(2), 10_000)
    c.flush()
    expect(out.map((x) => x.startMs)).toEqual([0, 10_000])
  })

  it('hears quiet speech on a quiet headset, and ignores steady room noise on a noisy mic', () => {
    // headset: near silence, then speech at rms 0.005
    expect(run(cat(quiet(3), tone(2, 0.007), quiet(2), tone(2, 0.007)))).toHaveLength(2)
    // noisy room (rms 0.014 hiss) with speech four times louder on top: only the speech makes a chunk
    const hiss = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.02 * Math.sin(i * 1.7))
    const talk = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.02 * Math.sin(i * 1.7) + 0.08 * Math.sin(i / 10))
    // (the first 2 s are the learning period, when any hiss louder than a quiet room still counts)
    const out = run(cat(hiss(5), talk(2), hiss(3))).filter((c) => c.startMs >= 2000)
    expect(out.map((c) => c.startMs)).toEqual([5000])
  })

  it('hears the people across the table in a room meeting, not only the one next to the mic', () => {
    // a standup around one laptop: room tone at rms 0.003, the person beside the mic at 0.04, the others at 0.007
    // (a little over twice the room). Every word of theirs must reach whisper, which has its own speech detector.
    const room = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.003 * Math.sqrt(2) * Math.sin(i * 1.3))
    const far = (sec: number) => tone(sec, 0.007 * Math.sqrt(2))
    const near = (sec: number) => tone(sec, 0.04 * Math.sqrt(2))
    const parts: Array<[Float32Array, boolean]> = [[room(4), false], [near(3), false], [room(0.3), false], [far(3), true], [room(1), false], [far(3), true], [room(2), false], [near(2), false], [room(1), false]]
    const farAt: Array<[number, number]> = []
    let at = 0
    for (const [x, isFar] of parts) { if (isFar) farAt.push([at, at + (x.length / RATE) * 1000]); at += (x.length / RATE) * 1000 }
    const out = run(cat(...parts.map(([x]) => x)))
    const covered = (a: number, b: number) => out.reduce((n, c) => n + Math.max(0, Math.min(b, c.startMs + secs(c) * 1000) - Math.max(a, c.startMs)), 0)
    for (const [a, b] of farAt) expect(covered(a, b) / (b - a)).toBeGreaterThan(0.95)
  })

  it('says how much of a chunk is clearly louder than the speech threshold of its track, so a faint sound can be told from talking', () => {
    // a quiet room (rms 0.001), then a faint sound just over the speech threshold, then someone talking
    const hum = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.0014 * Math.sin(i * 1.3))
    const out = run(cat(hum(4), tone(0.6, 0.008), hum(2), tone(1.5, 0.3), hum(1)))
    expect(out).toHaveLength(2)
    expect(out[0].clearMs).toBe(0)
    expect(out[1].clearMs).toBeGreaterThanOrEqual(1400)
    // quiet speech on a quiet headset is clear too
    expect(run(cat(quiet(3), tone(2, 0.007)))[0].clearMs).toBeGreaterThanOrEqual(1900)
  })

  it('works with frames of any size', () => {
    const all = cat(tone(3), quiet(1), tone(2))
    const out: Chunk[] = []
    const c = chunker((x) => out.push(x))
    for (let i = 0; i < all.length; i += 777) c.push('me', i / 16, all.subarray(i, i + 777))
    c.flush()
    expect(out.map((x) => x.startMs)).toEqual([0, 4000])
  })
})

describe('partials while someone keeps talking', () => {
  const partialsOf = (all: Float32Array, track: 'me' | 'them' = 'them', other?: Float32Array) => {
    const parts: Chunk[] = [], finals: Chunk[] = []
    const c = chunker((x) => finals.push(x), (x) => parts.push(x))
    // the other track's audio, if any, is heard at the same moments (frame by frame, like the recorder sends them)
    const step = RATE / 10
    for (let i = 0; i < all.length; i += step) {
      if (other) c.push(track === 'me' ? 'them' : 'me', i / 16, other.subarray(i, i + step))
      c.push(track, i / 16, all.subarray(i, i + step))
    }
    c.flush()
    return { parts, finals }
  }
  it('gives the chunk so far every 0.8 s from 0.8 s of speech on, each from the start of the chunk, then the final', () => {
    const { parts, finals } = partialsOf(cat(tone(3), quiet(1)))
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts.every((p) => p.startMs === 0)).toBe(true)
    expect(secs(parts[0])).toBeCloseTo(0.8, 1)
    expect(secs(parts[1])).toBeCloseTo(1.6, 1)
    expect(finals).toHaveLength(1)
  })
  it('gives none for a short remark, and none from the mic while the other side is talking', () => {
    expect(partialsOf(cat(tone(0.5), quiet(1))).parts).toEqual([])
    const mine = (o: ReturnType<typeof partialsOf>) => o.parts.filter((p) => p.track === 'me')
    expect(mine(partialsOf(cat(tone(3), quiet(1)), 'me', cat(tone(3), quiet(1))))).toEqual([])
    expect(mine(partialsOf(cat(tone(3), quiet(1)), 'me', quiet(4))).length).toBeGreaterThanOrEqual(3)
  })
  it('says whether a track is mid-sentence', () => {
    const c = chunker(() => {})
    feed(c.push, 'them', tone(1))
    expect(c.isOpen('them')).toBe(true)
    expect(c.isOpen('me')).toBe(false)
    feed(c.push, 'them', quiet(1), 1000)
    expect(c.isOpen('them')).toBe(false)
  })
})

describe('partials of a long sentence', () => {
  it('read the whole open chunk, from its start, every time', () => {
    const parts: Chunk[] = []
    const c = chunker(() => {}, (x) => parts.push(x))
    feed(c.push, 'them', tone(12), 5000)
    expect(parts.every((x) => x.startMs === 5000)).toBe(true)
    expect(secs(parts.at(-1)!)).toBeGreaterThan(11)
  })
})
