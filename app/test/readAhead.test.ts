import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishedParts, hookReadAhead, readAheadAllowed, readInSteps, readAheadText, READ_EVERY_MS, SETTLE_MS, shouldReadAhead, splitLong, stableTurns } from '../src/main/notes/readAhead'
import { enhancePrompt, summaryHead, summaryPrompt, transcriptText, type Llm } from '../src/main/notes/enhance'
import { createQueue } from '../src/main/notes/queue'
import { createNotesModel } from '../src/main/notes/model'
import type { Engine } from '../src/main/engine'
import { openStore, type Meeting, type Segment, type Store } from '../src/main/store'

const MIN = 60_000
const seg = (track: 'me' | 'them', startMs: number, text: string, speaker: string | null = track === 'me' ? 'me' : 'Ann Lee', len = 5000): Segment =>
  ({ id: startMs, meetingId: 'm', track, startMs, endMs: startMs + len, text, speaker })
/** a meeting where you and Ann Lee take turns every 10 s */
const talk = (minutes: number) => Array.from({ length: minutes * 6 }, (_, i) => seg(i % 2 ? 'them' : 'me', i * 10_000, `line ${i}.`))

describe('stableTurns: what of the transcript will not change any more', () => {
  it('takes lines that ended more than a minute ago, and holds back the last turn (the same voice may go on)', () => {
    const segs = talk(5)
    const { lines, untilMs } = stableTurns(segs, 5 * MIN)
    const settled = segs.filter((s) => s.endMs <= 5 * MIN - SETTLE_MS)
    // every settled line but the last turn
    expect(lines).toEqual(transcriptText(settled).split('\n').slice(0, -1))
    expect(untilMs).toBe(settled.at(-2)!.endMs)
  })
  it('after the meeting (final) every line is in, the last turn too', () => {
    const segs = talk(2)
    expect(stableTurns(segs, 2 * MIN, { final: true }).lines).toEqual(transcriptText(segs).split('\n'))
  })
})

describe('readAheadAllowed', () => {
  it('only on Macs with 32 GB or more: 24 GB keeps the model out of the way while recording', () => {
    expect(readAheadAllowed(24 * 2 ** 30)).toBe(false)
    expect(readAheadAllowed(32 * 2 ** 30)).toBe(true)
    expect(readAheadAllowed(64 * 2 ** 30)).toBe(true)
  })
})

describe('splitLong: one turn bigger than a part is cut at sentences, so no read is bigger than the context', () => {
  it('cuts it into pieces under the limit, each still saying who spoke', () => {
    const big = `Speaker A: ${'We ship the remote on Tuesday. '.repeat(200)}`
    const out = splitLong(['You: hi', big, 'Speaker B: ok'], 300)
    expect(out[0]).toBe('You: hi')
    expect(out.at(-1)).toBe('Speaker B: ok')
    expect(out.length).toBeGreaterThan(4)
    for (const l of out.slice(1, -1)) { expect(l.startsWith('Speaker A: ')).toBe(true); expect(Math.ceil(l.length / 3)).toBeLessThanOrEqual(300) }
  })
})

describe('shouldReadAhead', () => {
  const base = { live: true, backlogMs: 0, untilMs: 10 * MIN, readMs: 10 * MIN - READ_EVERY_MS }
  it('reads once there are 3 more minutes of settled transcript', () => {
    expect(shouldReadAhead(base)).toBe(true)
    expect(shouldReadAhead({ ...base, readMs: base.readMs + 1000 })).toBe(false)
  })
  it('reads more often when asked to (local checks on short clips)', () => {
    expect(shouldReadAhead({ ...base, readMs: base.untilMs - 45_000, everyMs: 45_000 })).toBe(true)
    expect(shouldReadAhead({ ...base, readMs: base.untilMs - 45_000 })).toBe(false)
  })
  it('never on a Mac with 16 GB or less (no live speakers there)', () => {
    expect(shouldReadAhead({ ...base, live: false })).toBe(false)
  })
  it('never while transcription is behind: over 10 s waiting, and so never over 30 s', () => {
    expect(shouldReadAhead({ ...base, backlogMs: 10_000 })).toBe(true)
    expect(shouldReadAhead({ ...base, backlogMs: 10_001 })).toBe(false)
    expect(shouldReadAhead({ ...base, backlogMs: 31_000 })).toBe(false)
  })
})

describe('what is read ahead is how the final prompts start', () => {
  const segs = talk(10)
  const final = transcriptText(segs)
  const ahead = readAheadText(stableTurns(segs, 10 * MIN).lines)
  it('the notes prompt starts with it, when the names stay the same', () => {
    const notes = enhancePrompt({ title: 'Sync', attendees: [{ name: 'Maya Chen', email: null }], mine: '- ship it', transcript: final, language: 'English' })
    expect(notes.startsWith(ahead)).toBe(true)
  })
  it('a name settled after the meeting is where the shared start ends', () => {
    const relettered = segs.map((s, i) => (i === 31 ? { ...s, speaker: 'Bo Park' } : s))
    const notes = enhancePrompt({ title: 'Sync', attendees: [], mine: '', transcript: transcriptText(relettered), language: '' })
    expect(notes.startsWith(ahead)).toBe(false)
    expect(notes.startsWith(readAheadText(transcriptText(segs.slice(0, 31)).split('\n')))).toBe(true)
  })
  it('a long meeting\'s part is read ahead as the start of its summary prompt', () => {
    expect(summaryPrompt('You: a\nSpeaker A: b', 3, 'English').startsWith(summaryHead(3) + 'You: a\nSpeaker A: b')).toBe(true)
  })
})

describe('finishedParts: a long meeting cut into parts while it is recorded', () => {
  it('a part is finished once the next line would not fit; the rest stays open', () => {
    // 1 + 1 for the line break
    expect(finishedParts([3, 3, 3, 3, 3, 3, 3], 9, 0)).toEqual([2, 4, 6])
    expect(finishedParts([3, 3, 3], 100, 0)).toEqual([])
  })
  it('starts after the parts already done', () => {
    expect(finishedParts([3, 3, 3, 3, 3, 3, 3], 9, 4)).toEqual([6])
  })
  it('a line bigger than a part stops the cutting (the notes split it themselves after the meeting)', () => {
    expect(finishedParts([3, 3, 3, 50, 3], 9, 0)).toEqual([2])
  })
})

describe('hookReadAhead', () => {
  const dirs: string[] = []
  const stores: Store[] = []
  afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })

  function setup(o: { live?: boolean; smallMac?: boolean; backlog?: () => number; contextSize?: number; gate?: Promise<void>; language?: string | null; attendees?: Array<{ name: string; email: string | null }> } = {}) {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-ahead-'))
    dirs.push(d)
    const store = openStore(join(d, 'yogurt.db'))
    stores.push(store)
    const m = store.createMeeting({ title: 'Sync', startedAt: 0, endedAt: null, eventId: null, app: null, attendees: o.attendees ?? [{ name: 'Ann Lee', email: null }, { name: 'Bo Park', email: null }, { name: 'Cy Ross', email: null }], state: 'recording', language: o.language ?? null })
    let now = 0
    const read: string[] = []
    const chats: string[] = []
    /** reads and chats in the order they happened */
    const order: string[] = []
    const llm: Llm = {
      contextSize: o.contextSize ?? 32_000,
      count: async (xs) => xs.map((x) => x.split(/\s+/).length),
      chat: async (prompt) => {
        chats.push(prompt); order.push(`chat ${prompt}`); return `- summary ${chats.length}`
      },
      readAhead: async (text) => { read.push(text); order.push(`read ${text}`); await o.gate },
    }
    const ticks: Array<() => void> = []
    const starts: Array<(m: Meeting) => void> = []
    const stops: Array<(m: Meeting) => void> = []
    const ahead = hookReadAhead({
      store, queue: createQueue({ recording: () => true, smallMac: o.smallMac ?? false, backlogMs: o.backlog }), model: { llm: async () => llm },
      live: o.live ?? true, backlogMs: o.backlog ?? (() => 0), language: () => 'english', transcribed: async () => {},
      now: () => now, every: (fn) => { ticks.push(fn); return () => {} }, onStart: (fn) => starts.push(fn), onStop: (fn) => stops.push(fn),
    })
    starts.forEach((f) => f(m))
    let added = 0
    // the lines heard by then go in, as transcription would save them
    const at = async (minutes: number, segs: Segment[]) => {
      now = minutes * MIN
      const fresh = segs.slice(added).filter((s) => s.endMs <= now)
      added += fresh.length
      store.addSegments(fresh.map(({ id: _id, ...s }) => ({ ...s, meetingId: m.id })))
      ticks.forEach((f) => f())
      await new Promise((r) => setTimeout(r, 5))
    }
    const stop = async () => { store.updateMeeting(m.id, { state: 'stopped', endedAt: now }); stops.forEach((f) => f({ ...m, endedAt: now })); await new Promise((r) => setTimeout(r, 5)) }
    return { m, store, read, chats, order, at, stop, ahead, starts }
  }

  it('reads the settled transcript in about every 3 minutes, then everything at the end', async () => {
    const s = setup()
    const segs = talk(12)
    await s.at(2, segs)
    expect(s.read).toEqual([])
    // by 5 minutes, lines up to 3:45 have settled
    await s.at(5, segs)
    expect(s.read).toHaveLength(1)
    await s.at(6, segs)
    expect(s.read).toHaveLength(1)
    await s.at(9, segs)
    expect(s.read).toHaveLength(2)
    expect(s.read[1].startsWith(s.read[0])).toBe(true)
    await s.at(12, segs)
    await s.stop()
    expect(s.read.at(-1)).toBe(readAheadText(transcriptText(s.store.segments(s.m.id)).split('\n')))
  })
  it('one read at a time: checks while one is still going add no second', async () => {
    let open!: () => void
    const s = setup({ gate: new Promise<void>((r) => { open = r }) })
    const segs = talk(12)
    await s.at(5, segs)
    await s.at(6, segs)
    open()
    await new Promise((r) => setTimeout(r, 5))
    // no tiny second read of the few lines that settled meanwhile
    expect(s.read).toHaveLength(1)
  })
  it('never on a Mac it is not allowed on (live: false), even when the queue would run it', async () => {
    const s = setup({ live: false, smallMac: false })
    const segs = talk(12)
    for (const t of [4, 8, 12]) await s.at(t, segs)
    await s.stop()
    expect(s.read).toEqual([])
  })
  it('never on a 16 GB Mac: the queue drops it there', async () => {
    const s = setup({ live: true, smallMac: true })
    const segs = talk(12)
    for (const t of [4, 8, 12]) await s.at(t, segs)
    await s.stop()
    expect(s.read).toEqual([])
  })
  it('never while transcription has more than 10 s of audio waiting', async () => {
    const s = setup({ backlog: () => 12_000 })
    const segs = talk(12)
    for (const t of [4, 8, 12]) await s.at(t, segs)
    expect(s.read).toEqual([])
  })
  it('a long meeting: each finished part is summarised while it records; the notes reuse those summaries', async () => {
    // about 2,600 words of lines: far more than a 1,500-token context holds whole
    const s = setup({ contextSize: 1500 })
    const segs = talk(40).map((x, i) => ({ ...x, text: `topic${i} ${'blah '.repeat(10)}` }))
    for (let t = 3; t <= 40; t += 3) await s.at(t, segs)
    expect(s.chats.length).toBeGreaterThan(0)
    expect(s.chats.every((c) => c.startsWith(summaryHead(s.chats.indexOf(c) + 1)))).toBe(true)
    const parts = s.ahead.parts(s.m.id)
    expect(parts.map((p) => p.summary)).toEqual(s.chats.map((_c, i) => `- summary ${i + 1}`))
    // parts follow on from each other from the first line
    const lines = transcriptText(s.store.segments(s.m.id)).split('\n')
    expect(parts.flatMap((p) => p.lines)).toEqual(lines.slice(0, parts.flatMap((p) => p.lines).length))
    // and what is read ahead is the open part's summary prompt
    expect(s.read.at(-1)!.startsWith(summaryHead(parts.length + 1))).toBe(true)
    // each summary's transcript was read in (in steps, so it can be stopped) right before it: the chat only writes
    for (const c of s.chats) {
      const i = s.order.indexOf(`chat ${c}`)
      const head = c.slice(0, c.indexOf('\n</transcript>'))
      expect(s.order[i - 1]).toBe(`read ${head}`)
    }
  })
  it('summaries are written in the meeting\'s own language when it is saved, before the guess from what was heard', async () => {
    const s = setup({ contextSize: 1500, language: 'de' })
    const segs = talk(40).map((x, i) => ({ ...x, text: `topic${i} ${'blah '.repeat(10)}` }))
    for (let t = 3; t <= 40; t += 3) await s.at(t, segs)
    expect(s.chats[0]).toContain('German')
  })
  it('after the meeting its parts stay for the notes; the next recording of that id starts afresh', async () => {
    const s = setup({ contextSize: 1500 })
    const segs = talk(40).map((x, i) => ({ ...x, text: `topic${i} ${'blah '.repeat(10)}` }))
    for (let t = 3; t <= 40; t += 3) await s.at(t, segs)
    await s.stop()
    const n = s.ahead.parts(s.m.id).length
    expect(n).toBeGreaterThan(0)
    s.starts.forEach((f) => f({ ...s.m, startedAt: 40 * MIN }))
    expect(s.ahead.parts(s.m.id)).toEqual([])
  })
})

describe('readInSteps: the model reads only what is new, a few thousand characters at a time', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Speaker A: line ${i} ${'x'.repeat(480)}`).join('\n')
  it('from where what it holds stops matching, in steps that end at a line break, so it can be stopped between them', async () => {
    const asked: string[] = []
    const held = await readInSteps(text.slice(0, 5000), text, async (t) => { asked.push(t) }, undefined, 4000)
    expect(held).toBe(text)
    expect(asked.at(-1)).toBe(text)
    for (const a of asked) expect(text.startsWith(a)).toBe(true)
    for (const a of asked.slice(0, -1)) expect(text[a.length]).toBe('\n')
    // each step adds at most a step and a line
    expect(asked[0].length).toBeLessThanOrEqual(5000 + 4000 + 600)
    expect(asked[0].length).toBeGreaterThan(5000)
  })
  it('nothing new (it holds this already, or more): nothing is read, so what it holds stays', async () => {
    const asked: string[] = []
    expect(await readInSteps(text + '\n</transcript> and the rest', text, async (t) => { asked.push(t) })).toBe(text + '\n</transcript> and the rest')
    expect(asked).toEqual([])
  })
  it('a step stopped while it waited is not counted as read', async () => {
    const ac = new AbortController()
    const held = await readInSteps('', text, async () => { ac.abort() }, ac.signal, 4000)
    expect(held).toBe('')
  })
  it('stopped: no further step', async () => {
    const ac = new AbortController()
    const asked: string[] = []
    const held = await readInSteps('', text, async (t) => { asked.push(t); if (asked.length === 2) ac.abort() }, ac.signal, 4000)
    expect(asked).toHaveLength(2)
    expect(held).toBe(asked[0])
  })
})

describe('the notes model reads ahead only what it does not hold', () => {
  function rig() {
    const preloads: string[] = []
    const engine: Engine = {
      load: async () => ({ contextSize: 32_000 }), unload: async () => {}, count: async (xs) => xs.map((x) => x.length),
      chat: async () => 'ok', preload: async (messages) => { preloads.push(messages.at(-1)!.content); return 1 }, embed: async () => [], unloadEmbed: async () => {}, onExit: () => {}, dispose: () => {},
    }
    return { preloads, model: createNotesModel({ engine, modelPath: () => '/m.gguf' }) }
  }
  it('after a prompt that starts with the transcript, its start is already there: nothing is sent', async () => {
    const r = rig()
    const llm = await r.model.llm()
    const lines = transcriptText(talk(3)).split('\n')
    await llm.chat(enhancePrompt({ title: '', attendees: [], mine: '', transcript: lines.join('\n'), language: '' }), () => {})
    await llm.readAhead!(readAheadText(lines))
    expect(r.preloads).toEqual([])
  })
  it('more transcript: only from where it held up to', async () => {
    const r = rig()
    const llm = await r.model.llm()
    const lines = transcriptText(talk(30)).split('\n')
    await llm.readAhead!(readAheadText(lines.slice(0, 10)))
    await llm.readAhead!(readAheadText(lines))
    expect(r.preloads[0]).toBe(readAheadText(lines.slice(0, 10)))
    expect(r.preloads.at(-1)).toBe(readAheadText(lines))
    // steps, never one that ends before what was already read
    for (const p of r.preloads.slice(1)) expect(p.length).toBeGreaterThan(r.preloads[0].length)
  })
})
