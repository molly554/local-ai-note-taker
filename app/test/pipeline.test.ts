import { describe, expect, it } from 'vitest'
import { createPipeline } from '../src/main/asr/pipeline'
import type { Chunk } from '../src/main/asr/chunker'
import { createTranscriber, type Line } from '../src/main/asr/transcribe'

const RATE = 16000
const tone = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 10))
const quiet = (sec: number) => new Float32Array(Math.round(sec * RATE))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(say: (c: Chunk) => Promise<Line[]> | Line[], opts: { holdMs?: number; maxQueuedMs?: number; echo?: boolean; nameOf?: (a: number, b: number) => string | null; respell?: (text: string) => string } = {}) {
  const warns: string[] = []
  const saved: Array<{ track: string; text: string; speaker: string | null; meetingId: string }> = []
  const sent: string[] = []
  let inFlight = 0, maxInFlight = 0
  const p = createPipeline({
    meetingId: 'm1',
    holdMs: opts.holdMs ?? 60, maxQueuedMs: opts.maxQueuedMs, onWarn: (k) => warns.push(k), nameOf: opts.nameOf, respell: opts.respell,
    ...(opts.echo ? { echoForTests: { echo: true, correlatedAt: () => true } } : {}),
    transcribe: async (c) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); try { return await say(c) } finally { inFlight-- } },
    // hidden echo lines are saved too, but they are not what these tests look at
    save: (segs) => { saved.push(...segs.filter((s) => !s.hidden)) },
    emit: (s) => { sent.push(s.text) },
  })
  /** one 1 s phrase of tone then 1 s of quiet so the chunker closes it */
  const speak = (track: 'me' | 'them', atMs: number) => {
    const all = Float32Array.from([...tone(1), ...quiet(1)])
    for (let i = 0; i < all.length; i += 1600) p.push(track, atMs + i / 16, all.subarray(i, i + 1600))
  }
  return { p, saved, sent, speak, warns, maxInFlight: () => maxInFlight }
}
const line = (c: Chunk, text: string): Line => ({ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text })

describe('pipeline', () => {
  it('replays only current unfinished words and clears them as finals settle or the meeting ends', async () => {
    const s = setup(() => [])
    s.p.speechPartial('them', { startMs: 0, endMs: 1200, text: 'Keep the launch notes', final: false })
    expect(s.p.partials().find((p) => p.track === 'them')).toMatchObject({ meetingId: 'm1', text: 'Keep the launch notes' })
    s.p.speechLines('them', [{ track: 'them', startMs: 0, endMs: 1200, text: 'Keep the launch notes' }])
    expect(s.p.partials().every((p) => !p.text && !p.words?.length)).toBe(true)
    s.p.speechPartial('them', { startMs: 2000, endMs: 3000, text: 'The next decision', final: false })
    expect(s.p.partials().find((p) => p.track === 'them')?.text).toBe('The next decision')
    await s.p.finish()
    expect(s.p.partials().every((p) => !p.text && !p.words?.length)).toBe(true)
  })

  it('says how much audio is waiting for transcription on its busiest track', async () => {
    const s = setup(() => new Promise<Line[]>(() => {}))
    expect(s.p.backlogMs()).toBe(0)
    // the first phrase goes to whisper (which never answers); the next two wait
    s.speak('them', 0); s.speak('them', 2000); s.speak('them', 4000)
    expect(s.p.backlogMs()).toBeGreaterThanOrEqual(2000)
    expect(s.p.backlogMs()).toBeLessThan(5000)
  })

  it('saves both sides with the right speaker and tells the window', async () => {
    const s = setup((c) => [line(c, c.track === 'me' ? 'I will send the notes' : 'Thanks for the update')])
    s.speak('me', 0); s.speak('them', 5000)
    await s.p.finish()
    expect(s.saved.map((x) => [x.track, x.speaker, x.text, x.meetingId])).toEqual(expect.arrayContaining([
      ['me', 'me', 'I will send the notes', 'm1'], ['them', null, 'Thanks for the update', 'm1'],
    ]))
    expect(s.sent.sort()).toEqual(['I will send the notes', 'Thanks for the update'])
  })

  it('a line of the other side gets the name the call app showed for its time; the mic is always the person', async () => {
    const asked: Array<[number, number]> = []
    const s = setup((c) => [line(c, c.track === 'me' ? 'mine' : 'theirs')], { nameOf: (a, b) => { asked.push([a, b]); return 'Dana Smith' } })
    s.speak('me', 0); s.speak('them', 5000)
    await s.p.finish()
    expect(s.saved.map((x) => [x.track, x.speaker])).toEqual(expect.arrayContaining([['me', 'me'], ['them', 'Dana Smith']]))
    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toBeGreaterThanOrEqual(5000)
  })

  it("saves and shows each line spelled the meeting's way", async () => {
    const s = setup((c) => [line(c, c.track === 'me' ? 'the Zentric checklist' : 'Zentric data')], { respell: (t) => t.replace('Zentric', 'Zentrik') })
    s.speak('me', 0); s.speak('them', 5000)
    await s.p.finish()
    expect(s.saved.map((x) => x.text).sort()).toEqual(['Zentrik data', 'the Zentrik checklist'])
    expect(s.sent.sort()).toEqual(['Zentrik data', 'the Zentrik checklist'])
  })

  it('holds a me line so a copy of what them said can be dropped', async () => {
    const s = setup((c) => [line(c, 'we should move the launch')], { echo: true })
    s.speak('them', 10_000)
    s.speak('me', 10_200)
    await s.p.finish()
    expect(s.saved.map((x) => x.track)).toEqual(['them'])
    expect(s.p.stats().echoDropped).toBe(1)
  })

  it('shows a them line at once but a me line only after the hold', async () => {
    const s = setup((c) => [line(c, c.track === 'me' ? 'my own words here' : 'their words here')], { holdMs: 400 })
    s.speak('me', 0); s.speak('them', 5000)
    await wait(200)
    expect(s.sent).toEqual(['their words here'])
    await wait(600)
    expect(s.sent).toContain('my own words here')
    await s.p.finish()
  })

  it('works on one chunk at a time per track, but both tracks at once', async () => {
    let both = 0, now = 0
    const s = setup(async (c) => { now++; both = Math.max(both, now); await wait(60); now--; return [line(c, `chunk ${c.startMs}`)] })
    s.speak('me', 0); s.speak('me', 3000); s.speak('me', 6000)
    await s.p.finish()
    expect(s.maxInFlight()).toBe(1)
    expect(s.saved).toHaveLength(3)
    const t = setup(async (c) => { await wait(60); return [line(c, 'x ' + c.track)] })
    t.speak('me', 0); t.speak('them', 0)
    await t.p.finish()
    expect(t.maxInFlight()).toBe(2)
  })

  it('goes on after a chunk fails', async () => {
    let n = 0
    const s = setup((c) => { if (n++ === 0) throw new Error('boom'); return [line(c, 'second chunk survives')] })
    s.speak('them', 0); s.speak('them', 3000)
    await s.p.finish()
    expect(s.saved.map((x) => x.text)).toEqual(['second chunk survives'])
  })

  it('finish releases held lines straight away and reports idle', async () => {
    const s = setup((c) => [line(c, 'last words before the end')], { holdMs: 60_000 })
    s.speak('me', 0)
    await s.p.finish()
    expect(s.saved).toHaveLength(1)
    expect(s.p.busy()).toBe(false)
  })
})

describe('pipeline when whisper falls behind', () => {
  /** a transcriber that holds every call until released */
  function stalled() {
    const calls: Chunk[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    return { calls, release: () => release(), say: async (c: Chunk) => { calls.push(c); await gate; return [line(c, `at ${c.startMs}`)] } }
  }

  it('keeps at most the cap of queued audio per track, dropping the oldest and recording what was dropped', async () => {
    const g = stalled()
    const s = setup(g.say, { maxQueuedMs: 5000 })
    // ten chunks of 1.2 s, 3 s apart; the first is in flight, nine queue, and 5 s holds four
    for (let i = 0; i < 10; i++) s.speak('them', i * 3000)
    const { dropped } = s.p.stats()
    expect(dropped.map((d) => d.startMs)).toEqual([3000, 6000, 9000, 12000, 15000])
    expect(dropped.every((d) => d.track === 'them' && d.endMs - d.startMs >= 1000)).toBe(true)
    g.release()
    await s.p.finish()
    expect(g.calls.map((c) => c.startMs)).toEqual([0, 18000, 21000, 24000, 27000])
    expect(s.saved).toHaveLength(5)
  })

  it('warns once, however much is dropped, and the other track is not touched', async () => {
    const g = stalled()
    const s = setup(g.say, { maxQueuedMs: 2000 })
    for (let i = 0; i < 8; i++) s.speak('them', i * 3000)
    s.speak('me', 0)
    expect(s.warns).toEqual(['falling-behind'])
    expect(s.p.stats().dropped.every((d) => d.track === 'them')).toBe(true)
    g.release()
    await s.p.finish()
  })

  it('holds 3 minutes of queued audio per track by default', async () => {
    const g = stalled()
    const s = setup(g.say)
    for (let i = 0; i < 200; i++) s.speak('them', i * 3000)
    // one in flight and 150 chunks of 1.2 s (180 s) waiting; the other 49 were dropped
    expect(s.p.stats().dropped).toHaveLength(49)
    g.release()
    await s.p.finish()
  }, 60_000)

  it('a chunk that fails to transcribe is skipped, and the first failure warns once', async () => {
    const s = setup(() => { throw new Error('boom') })
    s.speak('them', 0); s.speak('them', 3000); s.speak('me', 6000)
    await s.p.finish()
    expect(s.warns).toEqual(['transcribe-failed'])
  })
})

describe('partials', () => {
  const RATE = 16000
  it('a quick reading shows before the final line, is never saved, and is cleared by the final', async () => {
    const parts: Array<{ track: string; text: string }> = []
    const saved: string[] = [], sent: string[] = []
    const p = createPipeline({
      meetingId: 'm1', holdMs: 20,
      transcribe: async (c, o) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: o?.partial ? 'we should' : 'we should move the launch' }],
      save: (segs) => saved.push(...segs.map((s) => s.text)), emit: (s) => sent.push(s.text),
      emitPartial: (x) => parts.push({ track: x.track, text: x.text }),
    })
    const all = Float32Array.from([...tone(3), ...quiet(1)])
    for (let i = 0; i < all.length; i += 1600) { p.push('them', i / 16, all.subarray(i, i + 1600)); await wait(1) }
    await wait(50)
    expect(parts[0]).toEqual({ track: 'them', text: 'we should' })
    expect(parts.at(-1)).toEqual({ track: 'them', text: '' })
    expect(saved).toEqual(['we should move the launch'])
    expect(sent).toEqual(['we should move the launch'])
    expect(p.stats().delays.some((d) => d.partial)).toBe(true)
    expect(p.stats().delays.some((d) => !d.partial)).toBe(true)
  })
  it('a me line waits while the other side is mid-sentence, so the echo check can see their line', async () => {
    const saved: string[] = []
    const p = createPipeline({
      meetingId: 'm1', holdMs: 20, extraWaitMs: 400, echoForTests: { echo: true, correlatedAt: () => true },
      transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'we should move the launch' }],
      save: (segs) => saved.push(...segs.filter((s) => !s.hidden).map((s) => `${s.track}:${s.text}`)), emit: () => {},
    })
    // me says it and is done; them keeps talking (no pause yet)
    const me = Float32Array.from([...tone(1), ...quiet(1)])
    for (let i = 0; i < me.length; i += 1600) p.push('me', i / 16, me.subarray(i, i + 1600))
    const them = tone(2.5)
    for (let i = 0; i < them.length; i += 1600) p.push('them', i / 16, them.subarray(i, i + 1600))
    await wait(250)
    expect(saved).toEqual([])
    // their pause closes their chunk; the echo is caught
    const rest = quiet(1)
    for (let i = 0; i < rest.length; i += 1600) p.push('them', 2500 + i / 16, rest.subarray(i, i + 1600))
    await wait(300)
    expect(saved).toEqual(['them:we should move the launch'])
    expect(p.stats().echoDropped).toBe(1)
  })
})

const apple = (startMs: number, endMs: number, text: string, final = false, words?: Array<[string, number, number]>) =>
  ({ final, startMs, endMs, text, ...(words ? { words: words.map(([t, a, b]) => ({ text: t, startMs: a, endMs: b })) } : {}) })

describe('partials, held back when they would get in the way', () => {
  const RATE = 16000
  const feed = (p: ReturnType<typeof createPipeline>, track: 'me' | 'them', all: Float32Array, at = 0) => { for (let i = 0; i < all.length; i += 1600) p.push(track, at + i / 16, all.subarray(i, i + 1600)) }
  it("Apple's live words from the mic are not shown while the other side is mid-sentence (echo would show twice)", () => {
    const parts: string[] = []
    const p = createPipeline({ meetingId: 'm1', transcribe: async () => [], save: () => {}, emit: () => {}, emitPartial: (x) => parts.push(`${x.track}:${x.text}`) })
    feed(p, 'them', tone(2))
    p.speechPartial('me', apple(0, 2000, 'their words again'))
    expect(parts).toEqual([])
    p.speechPartial('them', apple(0, 2000, 'what they say'))
    expect(parts).toEqual(['them:what they say'])
    // they paused: the mic's words show again
    feed(p, 'them', quiet(1), 2000)
    p.speechPartial('me', apple(2500, 3000, 'my own words'))
    expect(parts.at(-1)).toBe('me:my own words')
  })
  it('what the mic said before the other side began stays while they talk', () => {
    const shown = new Map<string, string>()
    const p = createPipeline({ meetingId: 'm1', transcribe: async () => [], save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    p.speechPartial('me', apple(0, 1500, 'I think so'))
    feed(p, 'them', tone(1), 2000)
    p.speechPartial('me', apple(0, 3000, 'I think so and that'))
    expect(shown.get('me')).toBe('I think so')
  })
  it('a quick reading is skipped while a final waits on either track, or after a slow one', async () => {
    const parts: string[] = []
    let slow = false, asked = 0
    const p = createPipeline({
      meetingId: 'm1', holdMs: 20,
      transcribe: async (c, o) => { asked++; if (o?.partial && slow) await wait(900); else await wait(5); return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 500, text: o?.partial ? 'quick' : 'final words here' }] },
      save: () => {}, emit: () => {}, emitPartial: (x) => { if (x.text) parts.push(`${x.track}:${x.text}`) },
    })
    // a slow partial (900 ms) means the next one on any track is skipped
    slow = true
    feed(p, 'them', tone(1.0))
    await wait(1000)
    slow = false
    const before = parts.length
    feed(p, 'me', tone(1.0))
    await wait(100)
    expect(parts.length).toBe(before)
    expect(asked).toBeGreaterThan(0)
  })
  it('reads a long sentence quickly at most once per 1.6 s of its audio, the pace a loaded server allowed anyway', async () => {
    const ends: number[] = []
    const p = createPipeline({
      meetingId: 'm1', holdMs: 20,
      transcribe: async (c, o) => { if (o?.partial) ends.push(c.startMs + c.samples.length / 16); return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 500, text: o?.partial ? 'quick' : 'final' }] },
      save: () => {}, emit: () => {}, emitPartial: () => {},
    })
    const all = tone(4)
    for (let i = 0; i < all.length; i += 1600) { p.push('them', i / 16, all.subarray(i, i + 1600)); await wait(1) }
    expect(ends).toEqual([800, 2400, 4000])
  })
  it('one live reading per track: a sentence waiting for its final and the next one show as one, in order, and each final takes only its own words', async () => {
    const seen: string[] = []
    const p = createPipeline({
      meetingId: 'm1', holdMs: 20,
      transcribe: async (c, o) => { await wait(o?.partial ? 5 : 150); return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 500, text: o?.partial ? `quick ${c.startMs}` : `final ${c.startMs}` }] },
      save: () => {}, emit: () => {}, emitPartial: (x) => seen.push(`${x.track}:${x.text}`),
    })
    feed(p, 'them', Float32Array.from([...tone(1), ...quiet(1)]))
    await wait(30)
    expect(seen.at(-1)).toBe('them:quick 0')
    await wait(250)
    expect(seen.at(-1)).toBe('them:')
    feed(p, 'them', tone(1), 2000)
    await wait(30)
    expect(seen.at(-1)).toBe('them:quick 2000')
  })
})

describe("Apple's live words as it really sends them: no doubles, nothing heard vanishes", () => {
  const RATE = 16000
  const speechy = (sec: number) => new Float32Array(Math.round(sec * RATE)).map((_, i) => 0.2 * Math.sin(i / 7))
  const feed = (p: ReturnType<typeof createPipeline>, from: number, a: Float32Array) => { for (let i = 0; i < a.length; i += 1600) p.push('them', from + i / 16, a.subarray(i, i + 1600)) }
  const setupApple = () => {
    const shown = new Map<string, string>()
    const finals: string[] = []
    const p = createPipeline({ meetingId: 'm', holdMs: 0, transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + c.samples.length / 16, text: c.startMs < 5000 ? 'Okay, so this is like an extra long thought.' : 'But now I have a different idea.' }], save: () => {}, emit: (s) => finals.push(s.text), emitPartial: (x) => shown.set(x.track, x.text) })
    p.setQuickReads(false)
    return { p, shown, finals }
  }
  it("Apple's volatile reading starts at its last final's end, its final at the first word: the phrase shows once", async () => {
    const { p, shown } = setupApple()
    p.speechPartial('them', apple(0, 4000, 'Okay, so this is like an extra long'))
    p.speechPartial('them', apple(0, 4980, 'Okay, so this is like an extra long thought.', true, [['Okay,', 0, 360], [' so', 360, 420], [' this', 420, 540], [' is', 540, 660], [' like', 660, 1020], [' an', 1380, 1740], [' extra', 1740, 2040], [' long', 2040, 2520], [' thought.', 2520, 4920]]))
    p.speechPartial('them', apple(4980, 6000, 'But now'))
    expect(shown.get('them')).toBe('Okay, so this is like an extra long thought. But now')
    p.speechPartial('them', apple(4980, 8200, 'But now I have a different idea.'))
    p.speechPartial('them', apple(5640, 8160, 'But now I have a different idea.', true, [[' But', 5640, 6900], [' now', 6900, 7080], [' I', 7080, 7260], [' have', 7260, 7380], [' a', 7380, 7440], [' different', 7440, 7560], [' idea.', 7560, 8100]]))
    expect(shown.get('them')).toBe('Okay, so this is like an extra long thought. But now I have a different idea.')
  })
  it("whisper's final takes only its own words: Apple's words after it stay, and nothing of it comes back or stays twice", async () => {
    const { p, shown, finals } = setupApple()
    feed(p, 0, speechy(5))
    p.speechPartial('them', apple(0, 5000, 'Okay, so this is like this is like an extra long thought.', true, [['Okay,', 0, 360], [' so', 360, 420], [' this', 420, 540], [' is', 540, 660], [' like,', 660, 1020], [' this', 1020, 1140], [' is', 1140, 1260], [' like', 1260, 1380], [' an', 1380, 1740], [' extra', 1740, 2040], [' long', 2040, 2520], [' thought.', 2520, 4920]]))
    // a 1 s pause ends whisper's chunk
    feed(p, 5000, new Float32Array(RATE)); feed(p, 6000, speechy(2.6))
    p.speechPartial('them', apple(4980, 6200, 'But now I have'))
    await wait(20)
    expect(finals).toEqual(['Okay, so this is like an extra long thought.'])
    // the volatile words after whisper's line are still there
    expect(shown.get('them')).toBe('But now I have')
    p.speechPartial('them', apple(4980, 8200, 'But now I have a different idea.'))
    p.speechPartial('them', apple(5640, 8160, 'But now I have a different idea.', true, [[' But', 5640, 6900], [' now', 6900, 7080], [' I', 7080, 7260], [' have', 7260, 7380], [' a', 7380, 7440], [' different', 7440, 7560], [' idea.', 7560, 8100]]))
    expect(shown.get('them')).toBe('But now I have a different idea.')
    feed(p, 8600, new Float32Array(RATE)); await wait(30)
    expect(finals.at(-1)).toBe('But now I have a different idea.')
    expect(shown.get('them')).toBe('')
    p.speechPartial('them', apple(8160, 9500, 'So I can take'))
    expect(shown.get('them')).toBe('So I can take')
  })
  it("a volatile reading that runs on past whisper's cut keeps its later words, and Apple sending it again brings back none of the final's", async () => {
    const shown = new Map<string, string>()
    const p = createPipeline({ meetingId: 'm', holdMs: 0, transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + c.samples.length / 16, text: 'so I can take little breaks' }], save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    p.setQuickReads(false)
    feed(p, 0, speechy(2)); feed(p, 2000, new Float32Array(RATE))
    p.speechPartial('them', apple(0, 2500, 'So I can take a little break'))
    await wait(20)
    p.speechPartial('them', apple(0, 4000, 'So I can take a little breaks and they will'))
    expect(shown.get('them')).toBe('and they will')
    p.speechPartial('them', apple(0, 5000, 'So I can take a little breaks and they will all be'))
    expect(shown.get('them')).toBe('and they will all be')
  })
})

describe('whisper partials of a long sentence', () => {
  it('a sentence longer than 8 s keeps every word it said so far', async () => {
    const shown: string[] = []
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ')
    const p = createPipeline({
      meetingId: 'm', holdMs: 0, save: () => {}, emit: () => {}, emitPartial: (x) => shown.push(x.text),
      // one word a second, at its own time; only what the reading's audio covers
      transcribe: async (c, o) => {
        if (!o?.partial) return new Promise<Line[]>(() => {})
        const end = c.startMs + c.samples.length / 16
        const ws = words.map((t, i) => ({ text: ' ' + t, startMs: i * 1000 + 100, endMs: i * 1000 + 700 })).filter((w) => w.startMs >= c.startMs && w.endMs <= end)
        return [{ track: c.track, startMs: c.startMs, endMs: end, text: ws.map((w) => w.text.trim()).join(' '), words: ws }]
      },
    })
    const talk = (ms: number) => new Float32Array(1600).map((_, i) => 0.2 * Math.sin((ms * 16 + i) / 7))
    for (let ms = 0; ms < 12_000; ms += 100) { p.push('them', ms, talk(ms)); await wait(1) }
    await wait(20)
    expect(shown.at(-1)).toMatch(/^one two three .* ten/)
  })
})

describe("round 2: Apple's partials and dropped chunks", () => {
  const RATE = 16000
  const speechy = (sec: number) => new Float32Array(sec * RATE).map((_, i) => 0.2 * Math.sin(i / 7) * ((i / RATE) % 0.5 < 0.35 ? 1 : 0))
  it("whisper's final for a stretch takes Apple's words of that stretch, and only those", async () => {
    const shown = new Map<string, string>()
    const p = createPipeline({ meetingId: 'm', holdMs: 0, transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'so I think we should ship' }], save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    p.setQuickReads(false)
    p.speechPartial('them', apple(1030, 2000, 'so I'))
    p.speechPartial('them', apple(1030, 3900, 'so I think we should ship', true, [['so', 1030, 1300], [' I', 1300, 1500], [' think', 1500, 2000], [' we', 2000, 2500], [' should', 2500, 3000], [' ship', 3000, 3900]]))
    p.speechPartial('them', apple(5210, 6000, 'and then'))
    expect(shown.get('them')).toBe('so I think we should ship and then')
    const a = speechy(3)
    for (let i = 0; i < a.length; i += 1600) p.push('them', 1000 + i / 16, a.subarray(i, i + 1600))
    p.push('them', 4000, new Float32Array(RATE * 2))
    await wait(100)
    expect(shown.get('them')).toBe('and then')
    await p.finish()
    expect(shown.get('them')).toBe('')
  })
  it('a chunk the queue drops, or whose transcription fails, takes its partial with it', async () => {
    const shown = new Map<string, string>()
    let fail = true
    const p = createPipeline({ meetingId: 'm', holdMs: 0, maxQueuedMs: 1000, transcribe: async (c, o) => { if (o?.partial) return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 500, text: 'quick' }]; if (fail) throw new Error('boom'); return [] }, save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    const a = Float32Array.from([...speechy(1.2), ...new Float32Array(RATE)])
    for (let i = 0; i < a.length; i += 1600) p.push('them', i / 16, a.subarray(i, i + 1600))
    await wait(60)
    expect(shown.get('them') ?? '').toBe('')
  })
  it('an echo line found live is saved as hidden, not thrown away', async () => {
    const saved: Array<{ text: string; hidden?: boolean; echoConfident?: boolean }> = []
    const p = createPipeline({ meetingId: 'm', holdMs: 10, transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'we should move the launch to friday' }], save: (segs) => saved.push(...segs.map((s) => ({ text: s.text, hidden: s.hidden, echoConfident: s.echoConfident }))), emit: () => {}, echoForTests: { echo: true, correlatedAt: () => true } })
    const them = Float32Array.from([...speechy(1), ...new Float32Array(RATE)])
    for (let i = 0; i < them.length; i += 1600) p.push('them', i / 16, them.subarray(i, i + 1600))
    await wait(30)
    for (let i = 0; i < them.length; i += 1600) p.push('me', 200 + i / 16, them.subarray(i, i + 1600))
    await wait(300)
    expect(saved.map((s) => [s.text, !!s.hidden])).toEqual([['we should move the launch to friday', false], ['we should move the launch to friday', true]])
    expect(p.stats().echoDropped).toBe(1)
    expect(saved.find(s => s.hidden)?.echoConfident).toBe(true)
  })
  it("round 4: a mic line that the audio says is nothing but their voice is hidden when their line has most of its words", async () => {
    const saved: Array<{ text: string; hidden?: boolean; echoConfident?: boolean }> = []
    const p = createPipeline({ meetingId: 'm', holdMs: 10, transcribe: async (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: c.track === 'them' ? 'my name is Aileen and I work in marketing' : 'My name is Eileen.' }], save: (segs) => saved.push(...segs.map((s) => ({ text: s.text, hidden: s.hidden, echoConfident: s.echoConfident }))), emit: () => {}, echoForTests: { echo: true, correlatedAt: () => false, over: () => ({ correlated: true, loud: true, pure: true }) } })
    const them = Float32Array.from([...speechy(1), ...new Float32Array(RATE)])
    for (let i = 0; i < them.length; i += 1600) p.push('them', i / 16, them.subarray(i, i + 1600))
    await wait(30)
    for (let i = 0; i < them.length; i += 1600) p.push('me', 200 + i / 16, them.subarray(i, i + 1600))
    await wait(300)
    expect(saved.map((s) => [s.text, !!s.hidden])).toEqual([['my name is Aileen and I work in marketing', false], ['My name is Eileen.', true]])
    expect(p.echoOver(200, 1200)).toEqual({ correlated: true, loud: true, pure: true })
  })
})

describe("round 3: Apple's phrase across a whisper cut, and the next chunk's reading", () => {
  const RATE = 16000
  const talk = (ms: number) => new Float32Array(1600).map((_, i) => 0.2 * Math.sin((ms * 16 + i) / 7) * (((ms * 16 + i) / 1600) % 3 < 2 ? 1 : 0.3))
  it("Apple keeps a phrase going past whisper's 15 s cut: its later words stay until whisper's next final, then all is gone", async () => {
    const shown = new Map<string, string>()
    const p = createPipeline({ meetingId: 'm', holdMs: 0, transcribe: async (c, o) => (o?.partial ? [] : [{ track: c.track, startMs: c.startMs, endMs: c.startMs + c.samples.length / 16, text: 'whisper ' + c.startMs }]), save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    p.setQuickReads(false)
    const seen: string[] = []
    for (let ms = 1000; ms < 22_000; ms += 100) {
      p.push('them', ms, ms < 18_000 ? talk(ms) : new Float32Array(1600))
      if (ms >= 1500 && ms < 18_000 && ms % 500 === 0) p.speechPartial('them', apple(1030, ms, Array.from({ length: (ms - 1000) / 500 }, (_, i) => `w${i}`).join(' ')))
      seen.push(shown.get('them') ?? '')
      await wait(1)
    }
    await wait(200)
    // after whisper's first final (the 15 s cut) the words Apple heard after it were still shown
    expect(seen.some((t) => /w3\d/.test(t) && !/\bw0\b/.test(t))).toBe(true)
    expect(shown.get('them')).toBe('')
  })
  it("a final takes the readings of its own stretch only, not the next chunk's that starts where it ends", async () => {
    const shown = new Map<string, string>()
    const p = createPipeline({ meetingId: 'm', holdMs: 0, transcribe: async (c, o) => { if (o?.partial) return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + c.samples.length / 16, text: 'quick ' + c.startMs }]; await wait(30); return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + c.samples.length / 16, text: 'final' }] }, save: () => {}, emit: () => {}, emitPartial: (x) => shown.set(x.track, x.text) })
    for (let ms = 0; ms < 15_500; ms += 100) { p.push('them', ms, talk(ms)); await wait(1) }
    await wait(80)
    for (let ms = 15_500; ms < 17_000; ms += 100) { p.push('them', ms, talk(ms)); await wait(1) }
    await wait(60)
    // whisper cuts a long run at the quietest moment of its last 2 s, so the second chunk starts between 13 and 15 s
    expect(Number(/quick (\d+)/.exec(shown.get('them') ?? '')?.[1])).toBeGreaterThanOrEqual(12_000)
  })
})

describe('pipeline, quiet sounds that are not speech', () => {
  // whisper, as it answers on a quiet stretch: a stock line, or the prompt read back
  const whisperSays = (text: string): typeof fetch => (async () => new Response(JSON.stringify({ language: 'english', detected_language: 'english', detected_language_probability: 0.99, segments: [{ start: 0, end: 0.8, text: ` ${text}`, avg_logprob: -0.2, no_speech_prob: 0 }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
  const run = async (text: string, sound: Float32Array) => {
    const saved: string[] = []
    const transcribe = createTranscriber({ url: async () => 'http://whisper', fetchFn: whisperSays(text), prompt: () => 'With Alex Morgan of Zentrik.' })
    const p = createPipeline({ meetingId: 'm1', holdMs: 0, transcribe, save: (segs) => saved.push(...segs.filter((s) => !s.hidden).map((s) => `${s.track}: ${s.text}`)), emit: () => {} })
    // a quiet room for 4 s, the sound, then the room again so the chunk closes
    const hum = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.0014 * Math.sin(i * 1.3))
    const all = Float32Array.from([...hum(4), ...sound, ...hum(2)])
    for (let i = 0; i < all.length; i += 1600) p.push('them', i / 16, all.subarray(i, i + 1600))
    await p.finish()
    return saved
  }
  const faint = Float32Array.from({ length: 0.6 * RATE }, (_, i) => 0.008 * Math.sin(i / 10))

  it('a faint sound on the other side gives no "Thank you." line', async () => {
    expect(await run('Thank you.', faint)).toEqual([])
  })
  it('the prompt read back over a sound is never a line, however loud', async () => {
    expect(await run('Alex Morgan of Zentrik.', tone(1))).toEqual([])
  })
  it('a real "Thank you." is kept', async () => {
    expect(await run('Thank you.', tone(1))).toEqual(['them: Thank you.'])
  })
})
