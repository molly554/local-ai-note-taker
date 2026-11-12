import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Capture, encodeFrame, hookCapture, recordingFinished, type CaptureProc } from '../src/main/capture'
import { hookTranscription, settleTranscription, speechLocaleFor, spokenChanged, stopTranscriptionServer, transcribing } from '../src/main/asr'
import type { Spoken } from '../src/shared/spoken'
import type { TranscriptPartial } from '../src/shared/types'
import { openStore, type Meeting, type Store } from '../src/main/store'
import type { Line } from '../src/main/asr/transcribe'
import type { Chunk } from '../src/main/asr/chunker'

const RATE = 16000
const tone = (sec: number) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 10))
const tick = () => new Promise((r) => setTimeout(r, 15))

/** a stand-in recorder process: frames go in through `out`, 'stop' on stdin ends it */
function fakeProc() {
  const ev = new EventEmitter(), out = new PassThrough(), stdin = new PassThrough()
  /** what the recorder still sends after it is asked to stop (the real one flushes its last buffers), before it exits */
  const f = { lastWords: undefined as (() => void) | undefined }
  stdin.on('data', (d: Buffer) => {
    if (!d.toString().includes('stop')) return
    if (!f.lastWords) { setImmediate(() => ev.emit('exit', 0, null)); return }
    setTimeout(() => { f.lastWords!(); setTimeout(() => ev.emit('exit', 0, null), 30) }, 30)
  })
  const proc: CaptureProc = { stdout: out, stdin, on: (e, fn) => { ev.on(e, fn); return proc }, kill: () => { ev.emit('exit', null, 'SIGKILL'); return true } }
  return Object.assign(f, {
    proc, exit: (code: number | null, sig: NodeJS.Signals | null = null) => ev.emit('exit', code, sig),
    /** one phrase: 1 s of tone then 1 s of quiet, from meeting time `ms` */
    say: (track: 'me' | 'them', ms: number) => {
      const all = Float32Array.from([...tone(1), ...new Float32Array(RATE)])
      for (let i = 0; i < all.length; i += 1600) out.write(encodeFrame({ t: 'pcm', track, ms: ms + i / 16, samples: all.subarray(i, i + 1600) }))
    },
  })
}

let store: Store
beforeEach(() => { store = openStore(':memory:') })
const meeting = (): Meeting => store.createMeeting({ title: 't', startedAt: 1, endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' })
const says = (c: Chunk): Line[] => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: `${c.track} said it at ${c.startMs}` }]

const disposers: Array<() => void> = []
afterEach(async () => { disposers.splice(0).forEach((d) => d()); await settleTranscription(2000); stopTranscriptionServer() })

/** both hooks over one shared start/stop fan-out, registered in the order asked for */
function rig(order: 'capture-first' | 'transcription-first', t: { transcriber?: (c: Chunk, heard?: (language: string, chars: number) => void) => Promise<Line[]> | Line[]; modelPath?: () => string | undefined; refresh?: (id: string) => void; holdMs?: number } = {}) {
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  const onStart = (fn: (m: Meeting) => void) => { starts.push(fn); return () => {} }
  const onStop = (fn: (m: Meeting) => void) => { stops.push(fn); return () => {} }
  const procs: ReturnType<typeof fakeProc>[] = []
  const sent: string[] = [], warns: string[] = []
  const hookT = () => disposers.push(hookTranscription({
    store, modelPath: t.modelPath ?? (() => '/model.bin'), send: (s) => sent.push(`${s.track}:${s.text}`), warn: (c) => warns.push(c),
    refresh: t.refresh, holdMs: t.holdMs, transcriber: 'transcriber' in t ? t.transcriber : async (c) => says(c), onStart, onStop, pidFile: undefined,
  }))
  const hookC = () => hookCapture({
    dirOf: (id) => `/m/${id}`, onStart, onStop, stopMeeting: (id) => stops.forEach((f) => f({ id } as Meeting)),
    start: (_d, o) => { const f = fakeProc(); procs.push(f); return new Capture(f.proc, { startMs: o?.startMs }) }, join: async () => {},
  })
  if (order === 'capture-first') { hookC(); hookT() } else { hookT(); hookC() }
  return {
    procs, sent, warns,
    begin: (m: Meeting) => starts.forEach((f) => f(m)),
    stop: async (m: Meeting) => { stops.forEach((f) => f(m)); procs.at(-1)!.exit(0); await recordingFinished(m.id); await settleTranscription(5000) },
    /** the way the app stops: the recorder is asked to, flushes its last audio and exits on its own */
    stopGently: async (m: Meeting) => { stops.forEach((f) => f(m)); await recordingFinished(m.id); await settleTranscription(5000) },
  }
}

describe('live transcription of a meeting', () => {
  it('a resumed recording spells new words from the current invite without rewriting retained transcript', async () => {
    const r = rig('transcription-first', { transcriber: (c) => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'Zentric ships Tuesday.' }] })
    const m = meeting()
    store.updateMeeting(m.id, { attendees: [{ name: 'Ann Lee', email: 'ann@zentrik.example' }] })
    store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'Earlier Zentric discussion.', speaker: null }])
    const prior = store.segments(m.id)
    r.begin(m)
    r.procs[0].say('them', 5000)
    await tick()
    await r.stop(m)
    const all = store.segments(m.id)
    expect(all.slice(0, prior.length)).toEqual(prior)
    expect(all.at(-1)?.text).toBe('Zentrik ships Tuesday.')
    expect(r.sent).toEqual(['them:Zentrik ships Tuesday.'])
  })

  // index.ts hooks transcription before capture: its "meeting stopped" runs first, before the recorder is told to stop
  it('the last words the recorder sends after Stop are kept (the app\'s hook order)', async () => {
    const r = rig('transcription-first')
    const m = meeting()
    r.begin(m)
    r.procs[0].say('me', 500)
    r.procs[0].lastWords = () => r.procs[0].say('them', 4000)
    await tick()
    await r.stopGently(m)
    expect(store.segments(m.id).map((x) => x.text)).toEqual(['me said it at 500', 'them said it at 4000'])
  })

  it('when the transcript is done, the language most of it was in is saved on the meeting', async () => {
    const r = rig('transcription-first', { transcriber: (c, heard) => { heard?.(c.track === 'them' ? 'spanish' : 'english', c.track === 'them' ? 50 : 10); return says(c) } })
    const m = meeting()
    r.begin(m)
    r.procs[0].say('me', 500)
    r.procs[0].say('them', 5000)
    await tick()
    await r.stop(m)
    expect(store.meeting(m.id)!.language).toBe('spanish')
  })

  for (const order of ['capture-first', 'transcription-first'] as const) {
    it(`start, audio, stop saves and sends the lines (${order})`, async () => {
      const r = rig(order)
      const m = meeting()
      r.begin(m)
      r.procs[0].say('me', 500)
      r.procs[0].say('them', 5000)
      await tick()
      await r.stop(m)
      const segs = store.segments(m.id)
      expect(segs.map((s) => [s.track, s.speaker, s.text])).toEqual([['me', 'me', 'me said it at 500'], ['them', null, 'them said it at 5000']])
      expect(r.sent.sort()).toEqual(['me:me said it at 500', 'them:them said it at 5000'])
      expect(transcribing()).toBe(false)
    })
  }

  for (const resumed of [false, true]) it(`after the meeting, echoes are swept out without changing prior transcript (${resumed ? 'resumed' : 'new'})`, async () => {
    const refreshed: string[] = []
    // whisper hears the same words on both tracks; the them chunk takes long, so the me line is saved before it arrives
    const slow = async (c: Chunk): Promise<Line[]> => {
      if (c.track === 'them') await new Promise((r) => setTimeout(r, 120))
      return [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'we should move the launch to friday' }]
    }
    const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
    const procs: ReturnType<typeof fakeProc>[] = []
    hookCapture({ dirOf: (id) => `/m/${id}`, onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, stopMeeting: () => {}, start: () => { const f = fakeProc(); procs.push(f); return new Capture(f.proc) }, join: async () => {} })
    disposers.push(hookTranscription({ store, modelPath: () => '/model.bin', send: () => {}, warn: () => {}, refresh: (id) => refreshed.push(id), transcriber: slow, holdMs: 20, extraWaitMs: 20, onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, pidFile: undefined }))
    const m = meeting()
    // A retained line at the session boundary must not be reclassified by new audio.
    if (resumed) store.addSegments([{ meetingId: m.id, track: 'me', startMs: 1400, endMs: 2400, text: 'we should move the launch to friday', speaker: 'me' }])
    const prior = store.segments(m.id), priorIds = new Set(prior.map((s) => s.id))
    starts.forEach((f) => f(m))
    expect(procs).toHaveLength(1)
    procs[0].say('me', 1200)
    // the me line is out (the hold is over, the release timer ran) before their chunk has even been heard
    await expect.poll(() => store.segments(m.id).filter((s) => !priorIds.has(s.id)).map((s) => s.track), { timeout: 2000 }).toEqual(['me'])
    procs[0].say('them', 1000)
    // and the rest of the meeting: their voice on the mic a little late, so the audio says echo is present
    for (let k = 1; k < 14; k++) { procs[0].say('them', k * 2000 + 1000); procs[0].say('me', k * 2000 + 1200) }
    await new Promise((r) => setTimeout(r, 400))
    stops.forEach((f) => f(m))
    await recordingFinished(m.id)
    await settleTranscription(15_000)
    // the copy is hidden, not gone
    expect(store.segments(m.id).filter((s) => !priorIds.has(s.id) && s.startMs < 2000).map((s) => s.track)).toEqual(['them'])
    expect(store.segments(m.id, { hidden: true }).filter((s) => !priorIds.has(s.id) && s.startMs < 2000).map((s) => [s.track, s.hidden])).toEqual([['them', false], ['me', true]])
    expect(store.segments(m.id).filter((s) => priorIds.has(s.id))).toEqual(prior)
    expect(new Set(refreshed)).toEqual(new Set([m.id]))
  })

  it('a restarted recorder keeps feeding the same meeting', async () => {
    const r = rig('transcription-first')
    const m = meeting()
    r.begin(m)
    r.procs[0].say('them', 500)
    await tick()
    r.procs[0].exit(null, 'SIGKILL')
    expect(r.procs).toHaveLength(2)
    r.procs[1].say('them', 10_000)
    await tick()
    await r.stop(m)
    expect(store.segments(m.id).map((s) => s.startMs)).toEqual([500, 10_000])
  })

  it('tells once per meeting when chunks fail, and again in the next meeting', async () => {
    const r = rig('capture-first', { transcriber: async () => { throw new Error('boom') } })
    const a = meeting()
    r.begin(a)
    r.procs[0].say('them', 500); r.procs[0].say('them', 4000)
    await tick()
    await r.stop(a)
    expect(r.warns).toEqual(['transcribe-failed'])
    const b = meeting()
    r.begin(b)
    r.procs[1].say('them', 500)
    await tick()
    await r.stop(b)
    expect(r.warns).toEqual(['transcribe-failed', 'transcribe-failed'])
  })

  it('without a speech model the meeting still records, and says so once', async () => {
    const r = rig('transcription-first', { transcriber: undefined, modelPath: () => undefined })
    // no injected transcriber: the real path is taken, and it finds no model
    const m = meeting()
    r.begin(m)
    r.procs[0].say('me', 500)
    await new Promise((res) => setTimeout(res, 700))
    expect(r.warns).toEqual(['no-speech-model'])
    await r.stop(m)
    expect(store.segments(m.id)).toEqual([])
  })
})

describe('whisper-server between meetings', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  function fakeServers() {
    const made: Array<{ urls: number; stops: number }> = []
    const make = () => {
      const rec = { urls: 0, stops: 0 }
      made.push(rec)
      return { url: async () => { rec.urls++; return 'http://127.0.0.1:1' }, resetBudget: () => {}, wedged: async () => 'http://127.0.0.1:1', alive: async () => true, kill: () => {}, stop: async () => { rec.stops++ } } as unknown as import('../src/main/asr/server').WhisperServer
    }
    return { made, make }
  }
  function hooks(server: () => import('../src/main/asr/server').WhisperServer, idleMs: number) {
    const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
    disposers.push(hookTranscription({
      store, modelPath: () => '/model.bin', send: () => {}, warn: () => {}, server, serverIdleMs: idleMs,
      onStart: (fn) => { starts.push(fn) }, onStop: (fn) => { stops.push(fn) },
    }))
    return { begin: (m: Meeting) => starts.forEach((f) => f(m)), end: async (m: Meeting) => { stops.forEach((f) => f(m)); await settleTranscription(2000) } }
  }

  it('starts (warms up) when a meeting starts, stops a while after the last one, and starts again for the next', async () => {
    const s = fakeServers()
    const h = hooks(s.make, 60)
    const a = meeting()
    h.begin(a)
    expect(s.made).toHaveLength(1)
    expect(s.made[0].urls).toBe(1)
    await h.end(a)
    await wait(20)
    expect(s.made[0].stops).toBe(0)
    await wait(80)
    expect(s.made[0].stops).toBe(1)
    const b = meeting()
    h.begin(b)
    expect(s.made).toHaveLength(2)
    expect(s.made[1].urls).toBe(1)
    await h.end(b)
  })
  it('a meeting starting before the wait is up keeps the same server running', async () => {
    const s = fakeServers()
    const h = hooks(s.make, 60)
    const a = meeting()
    h.begin(a); await h.end(a)
    await wait(20)
    const b = meeting()
    h.begin(b)
    await wait(80)
    expect(s.made).toHaveLength(1)
    expect(s.made[0].stops).toBe(0)
    await h.end(b)
  })
})

describe('the spoken language picked', () => {
  /** Apple's speech on a Mac with English and Spanish models, the last meeting in Spanish */
  async function speechRig(spoken: () => Spoken) {
    const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
    const procs: Array<ReturnType<typeof fakeProc> & { locale?: string | null }> = []
    const parts: TranscriptPartial[] = []
    disposers.push(hookTranscription({
      store, modelPath: () => '/model.bin', send: () => {}, warn: () => {}, transcriber: async (c) => says(c), sendPartial: (x) => parts.push(x),
      onStart: (fn) => { starts.push(fn) }, onStop: (fn) => { stops.push(fn) }, spoken,
      speech: { host: { platform: 'darwin', arch: 'arm64', osRelease: '25.4.0' }, binary: '/none', ui: () => 'en-GB', last: () => 'spanish',
        locales: async () => ({ available: true, supported: ['en-GB', 'en-US', 'es-ES'], installed: ['en-GB', 'en-US', 'es-ES'] }), install: async () => true },
    }))
    hookCapture({
      dirOf: (id) => `/m/${id}`, onStart: (fn) => { starts.push(fn); return () => {} }, onStop: (fn) => { stops.push(fn); return () => {} }, stopMeeting: () => {}, join: async () => {},
      speech: (id) => speechLocaleFor(id),
      start: (_d, o) => { const f = Object.assign(fakeProc(), { locale: o?.speech ?? null }); procs.push(f); return new Capture(f.proc) },
    })
    await tick()
    const m = meeting()
    starts.forEach((f) => f(m))
    const speak = (text: string) => (procs[0].proc.stdout as PassThrough).write(encodeFrame({ t: 'speech', track: 'them', final: false, startMs: 0, endMs: 900, text }))
    return { m, procs, parts, speak, stop: async () => { stops.forEach((f) => f(m)); procs[0].exit(0); await recordingFinished(m.id); await settleTranscription(2000) } }
  }

  it("English only: Apple's speech listens in English, in the interface's region, whatever the last meeting was in", async () => {
    const r = await speechRig(() => 'en')
    expect(r.procs[0].locale).toBe('en-GB')
    await r.stop()
  })
  it("Multi-language: today's choice, the last meeting's language", async () => {
    const r = await speechRig(() => 'multi')
    expect(r.procs[0].locale).toBe('es-ES')
    await r.stop()
  })
  it("switched to English only while recording in Spanish: Apple's Spanish words are set aside, whisper's come back", async () => {
    let spoken: Spoken = 'multi'
    const r = await speechRig(() => spoken)
    r.speak('hola')
    await expect.poll(() => r.parts.some((x) => x.text.includes('hola'))).toBe(true)
    spoken = 'en'
    spokenChanged()
    r.speak('adios')
    await new Promise((res) => setTimeout(res, 80))
    expect(r.parts.some((x) => x.text.includes('adios'))).toBe(false)
    await r.stop()
  })
})

it('refreshes saved live echoes with their IDs before recording ends', async () => {
  const refreshed: string[] = []
  const r = rig('transcription-first', { holdMs: 20, refresh: id => refreshed.push(id), transcriber: async c => [{ track: c.track, startMs: c.startMs, endMs: c.startMs + 1000, text: 'we should move the launch to friday' }] })
  const m = meeting(); r.begin(m)
  for (let i = 0; i < 14; i++) {
    r.procs[0].say('them', i * 2000 + 1000)
    await tick()
    r.procs[0].say('me', i * 2000 + 1200)
  }
  await expect.poll(() => refreshed.length, { timeout: 3000 }).toBeGreaterThan(0)
  expect(store.segments(m.id, { hidden: true }).some(s => s.hidden && Number.isInteger(s.id))).toBe(true)
  expect(store.segments(m.id).every(s => !s.hidden)).toBe(true)
  await r.stop(m)
})
