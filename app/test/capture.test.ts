import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Capture, captureArgs, foldersToJoin, hookCapture, recordingBusy, recordingFinished, recordingPaused, recordingSettled, rejoinInterrupted, setRecordingPaused, settleRecording, encodeFrame, FrameParser, type CaptureOpts, type CaptureProc, type Frame } from '../src/main/capture'
import { fakeAudioDuration, fakeCaptureProc, joinFakeParts } from '../src/main/fakeCapture'
import { fakeMicList, setFakeMics } from '../src/main/fake'
import { openStore } from '../src/main/store'

const pcm = (track: 'me' | 'them', ms: number, xs: number[]): Frame => ({ t: 'pcm', track, ms, samples: Float32Array.from(xs) })

describe('frame parser', () => {
  it('reads a pcm frame split across chunk boundaries, one byte at a time', () => {
    const bytes = Buffer.concat([encodeFrame(pcm('me', 120, [0.5, -0.25, 1])), encodeFrame({ t: 'level', me: 0.2, them: 0.4 })])
    const p = new FrameParser()
    const out: Frame[] = []
    for (let i = 0; i < bytes.length; i++) out.push(...p.push(bytes.subarray(i, i + 1)))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ t: 'pcm', track: 'me', ms: 120 })
    expect(Array.from((out[0] as Extract<Frame, { t: 'pcm' }>).samples)).toEqual([0.5, -0.25, 1])
    expect(out[1]).toEqual({ t: 'level', me: 0.2, them: 0.4 })
  })

  it('keeps two interleaved tracks apart', () => {
    const p = new FrameParser()
    const bytes = Buffer.concat([encodeFrame(pcm('me', 0, [0.1])), encodeFrame(pcm('them', 0, [0.2, 0.3])), encodeFrame(pcm('me', 100, [0.4]))])
    // two uneven chunks, cut in the middle of the second frame's samples
    const cut = bytes.length - 20
    const out = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut))] as Extract<Frame, { t: 'pcm' }>[]
    expect(out.map((f) => [f.track, f.ms, Array.from(f.samples).map((x) => Math.round(x * 10) / 10)])).toEqual([
      ['me', 0, [0.1]], ['them', 0, [0.2, 0.3]], ['me', 100, [0.4]],
    ])
  })

  it('reads every warn code, no-mic included, and drops ones it does not know', () => {
    const p = new FrameParser()
    const codes = ['no-system-audio', 'device-changed', 'no-mic', 'mic-gone', 'something-else'] as const
    const out = p.push(Buffer.concat(codes.map((code) => Buffer.from(JSON.stringify({ t: 'warn', code }) + '\n'))))
    expect(out).toEqual([{ t: 'warn', code: 'no-system-audio' }, { t: 'warn', code: 'device-changed' }, { t: 'warn', code: 'no-mic' }, { t: 'warn', code: 'mic-gone' }])
  })

  it('skips a line it cannot read and carries on', () => {
    const p = new FrameParser()
    const out = p.push(Buffer.concat([Buffer.from('not json\n'), encodeFrame({ t: 'warn', code: 'device-changed' })]))
    expect(out).toEqual([{ t: 'warn', code: 'device-changed' }])
  })
})

/** A stand-in for the helper process: tests write its stdout and read its stdin */
function fakeProc() {
  const ev = new EventEmitter()
  const stdin = new PassThrough(), stdout = new PassThrough()
  const commands: string[] = []
  stdin.on('data', (d: Buffer) => commands.push(...d.toString().split('\n').filter(Boolean)))
  const proc: CaptureProc = {
    stdin, stdout,
    on: (e, fn) => { ev.on(e, fn); return proc },
    kill: () => { ev.emit('exit', null, 'SIGKILL'); return true },
  }
  return { proc, out: stdout, commands, exit: (code: number | null, signal: NodeJS.Signals | null = null) => ev.emit('exit', code, signal) }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('Capture', () => {
  it('emits pcm with the track, start time and samples', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    const got: unknown[] = []
    c.on('pcm', (track, ms, samples) => got.push([track, ms, Array.from(samples)]))
    f.out.write(encodeFrame(pcm('them', 300, [0.5, 0.25])))
    await tick()
    expect(got).toEqual([['them', 300, [0.5, 0.25]]])
  })

  it('emits a level message', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    const got: unknown[] = []
    c.on('level', (lv) => got.push(lv))
    f.out.write(encodeFrame({ t: 'level', me: 0.3, them: 0 }))
    await tick()
    expect(got).toEqual([{ me: 0.3, them: 0 }])
  })

  it('a warn message emits warn', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    const got: string[] = []
    c.on('warn', (code) => got.push(code))
    f.out.write(encodeFrame({ t: 'warn', code: 'no-system-audio' }))
    await tick()
    expect(got).toEqual(['no-system-audio'])
  })

  it('pause, resume and stop go to the helper as lines', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    c.pause(); c.resume()
    const stopped = c.stop()
    await tick()
    expect(f.commands).toEqual(['pause', 'resume', 'stop'])
    const ended: unknown[] = []
    c.on('ended', (e) => ended.push(e))
    f.exit(0)
    await stopped
    expect(ended).toEqual([{ crashed: false }])
  })

  it('the helper exiting mid-meeting emits ended with crashed', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    const ended: unknown[] = []
    c.on('ended', (e) => ended.push(e))
    f.exit(null, 'SIGKILL')
    expect(ended).toEqual([{ crashed: true }])
    expect(c.pause()).toBe(false)
    expect(c.resume()).toBe(false)
    // stopping after that is harmless
    await c.stop()
  })
})

describe('fake capture', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('pause emits no new PCM; resuming retains the existing meeting timeline', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yogurt-cap-pause-'))
    const c = new Capture(fakeCaptureProc(dir))
    const frames: number[] = []
    c.on('pcm', (_track, ms) => frames.push(ms))
    await new Promise((r) => setTimeout(r, 350))
    expect(frames.length).toBeGreaterThan(0)
    expect(c.pause()).toBe(true)
    const before = frames.length, at = frames.at(-1)!
    await new Promise((r) => setTimeout(r, 250))
    expect(frames).toHaveLength(before)
    expect(c.resume()).toBe(true)
    await new Promise((r) => setTimeout(r, 250))
    expect(frames.length).toBeGreaterThan(before)
    expect(frames[before]).toBeGreaterThan(at + 200)
    await c.stop()
  })

  it('append parts preserve the complete original PCM prefix and carry forward timeline after reopening', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yogurt-cap-append-'))
    const first = new Capture(fakeCaptureProc(dir))
    await new Promise((r) => setTimeout(r, 350)); await first.stop()
    const original = readFileSync(join(dir, 'me.wav')), startMs = fakeAudioDuration(dir)
    expect(startMs).toBeGreaterThan(0)
    const second = new Capture(fakeCaptureProc(dir, startMs, { part: 1 }), { startMs })
    const frames: number[] = []
    second.on('pcm', (_track, ms) => frames.push(ms))
    await new Promise((r) => setTimeout(r, 350)); await second.stop()
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(original)
    expect(frames[0]).toBeGreaterThanOrEqual(startMs)
    expect(() => fakeAudioDuration(dir)).toThrow('Unjoined')
    joinFakeParts(dir)
    const combined = readFileSync(join(dir, 'me.wav'))
    expect(combined.subarray(44, original.length)).toEqual(original.subarray(44))
    expect(fakeAudioDuration(dir)).toBeGreaterThan(startMs)
    joinFakeParts(dir)
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(combined)
  })

  it('records from the chosen fake mic, switches without stopping, and falls back to Auto when it goes away', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yogurt-cap-mic-'))
    setFakeMics(null)
    const c = new Capture(fakeCaptureProc(dir, 0, { mic: 'fake-yeti' }))
    const mics: unknown[] = [], warns: string[] = [], frames: number[] = []
    c.on('mic', (m) => mics.push(m)); c.on('warn', (w) => warns.push(w)); c.on('pcm', (track, ms) => { if (track === 'me') frames.push(ms) })
    await new Promise((r) => setTimeout(r, 150))
    expect(mics).toEqual([{ uid: 'fake-yeti', name: 'Yeti Stereo Microphone' }])
    c.setMic('BuiltInMicrophoneDevice')
    await new Promise((r) => setTimeout(r, 150))
    expect(mics.at(-1)).toEqual({ uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' })
    // a mic that isn't here changes nothing
    c.setMic('nope')
    await new Promise((r) => setTimeout(r, 100))
    expect(mics.at(-1)).toEqual({ uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' })
    c.setMic('fake-yeti')
    await new Promise((r) => setTimeout(r, 100))
    const before = frames.length
    setFakeMics(fakeMicList().filter((m) => m.uid !== 'fake-yeti'))
    await new Promise((r) => setTimeout(r, 200))
    expect(warns).toContain('mic-gone')
    expect(mics.at(-1)).toEqual({ uid: null, name: 'MacBook Pro Microphone' })
    // the recording went on
    expect(frames.length).toBeGreaterThan(before)
    await c.stop()
    setFakeMics(null)
  })

  it('a remembered fake mic that is not here records with Auto, quietly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yogurt-cap-mic-'))
    setFakeMics(null)
    const c = new Capture(fakeCaptureProc(dir, 0, { mic: 'unplugged' }))
    const mics: unknown[] = [], warns: string[] = []
    c.on('mic', (m) => mics.push(m)); c.on('warn', (w) => warns.push(w))
    await new Promise((r) => setTimeout(r, 150))
    expect(mics).toEqual([{ uid: null, name: 'MacBook Pro Microphone' }])
    expect(warns).toEqual([])
    await c.stop()
  })

  it('plays both fixture tracks at real-time speed, and stops', async () => {
    dir = mkdtempSync(join(tmpdir(), 'yogurt-cap-'))
    const c = new Capture(fakeCaptureProc(dir))
    const got: { track: string; ms: number; n: number }[] = []
    c.on('pcm', (track, ms, samples) => got.push({ track, ms, n: samples.length }))
    const started = Date.now()
    await new Promise((r) => setTimeout(r, 450))
    const tracks = new Set(got.map((g) => g.track))
    expect(tracks).toEqual(new Set(['me', 'them']))
    // real time: no more audio than the time that has passed (plus one chunk)
    const meSamples = got.filter((g) => g.track === 'me').reduce((a, g) => a + g.n, 0)
    expect(meSamples).toBeLessThanOrEqual(((Date.now() - started) / 1000 + 0.1) * 16000)
    expect(meSamples).toBeGreaterThan(0)
    await c.stop()
  })
})

describe('after a crash', () => {
  it('the meeting row is stopped on the next start and its segments remain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-db-'))
    try {
      const file = join(dir, 'yogurt.db')
      const s1 = openStore(file)
      const m = s1.createMeeting({ title: 'x', startedAt: 1, endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' })
      s1.addSegments([{ meetingId: m.id, track: 'me', startMs: 0, endMs: 900, text: 'hello there', speaker: null }])
      // the app dies here without stopping the meeting
      s1.close()
      const s2 = openStore(file)
      expect(s2.markInterrupted()).toBe(1)
      expect(s2.meeting(m.id)?.state).toBe('stopped')
      expect(s2.segments(m.id).map((x) => x.text)).toEqual(['hello there'])
      s2.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('helper arguments', () => {
  it('the first run has no part, a restart names its part and where meeting time stands', () => {
    expect(captureArgs('/m/1')).toEqual(['record', '--dir', '/m/1'])
    expect(captureArgs('/m/1', { part: 2, startMs: 4100 })).toEqual(['record', '--dir', '/m/1', '--part', '2', '--start-ms', '4100'])
  })
  it('names the chosen mic; Auto names none', () => {
    expect(captureArgs('/m/1', { mic: 'usb:yeti' })).toEqual(['record', '--dir', '/m/1', '--mic', 'usb:yeti'])
    expect(captureArgs('/m/1', { mic: null })).toEqual(['record', '--dir', '/m/1'])
  })
})

describe('choosing the mic while recording', () => {
  it('reads the mic frame and the mic-gone warning', () => {
    const p = new FrameParser()
    const out = p.push(Buffer.from([
      JSON.stringify({ t: 'mic', uid: 'usb:yeti', name: 'Yeti Stereo Microphone' }), JSON.stringify({ t: 'mic', uid: null, name: null }),
      JSON.stringify({ t: 'mic', uid: 3, name: 'x' }), JSON.stringify({ t: 'warn', code: 'mic-gone' }),
    ].join('\n') + '\n'))
    expect(out).toEqual([{ t: 'mic', uid: 'usb:yeti', name: 'Yeti Stereo Microphone' }, { t: 'mic', uid: null, name: null }, { t: 'warn', code: 'mic-gone' }])
  })
  it('Capture passes the mic in use on, and sends a switch as a line', async () => {
    const f = fakeProc(); const c = new Capture(f.proc)
    const got: unknown[] = []
    c.on('mic', (m) => got.push(m))
    f.out.write(encodeFrame({ t: 'mic', uid: null, name: 'MacBook Pro Microphone' }))
    await tick()
    expect(got).toEqual([{ uid: null, name: 'MacBook Pro Microphone' }])
    expect(c.setMic('usb:yeti')).toBe(true)
    expect(c.setMic(null)).toBe(true)
    await tick()
    expect(f.commands).toEqual(['mic usb:yeti', 'mic auto'])
  })
})

describe('Capture end time', () => {
  it('is the end of the last audio heard, and never before where this run starts', async () => {
    const f = fakeProc(); const c = new Capture(f.proc, { startMs: 5000 })
    expect(c.endMs).toBe(5000)
    f.out.write(encodeFrame(pcm('me', 5000, new Array(1600).fill(0.1))))
    f.out.write(encodeFrame(pcm('them', 5100, new Array(1600).fill(0.1))))
    await tick()
    expect(c.endMs).toBe(5200)
  })
})

describe('restart after a crash', () => {
  /** hookCapture over stand-in helpers; each start is recorded with its options */
  function rig() {
    const starts: { dir: string; opts?: CaptureOpts }[] = []
    const procs: ReturnType<typeof fakeProc>[] = []
    const joined: string[] = []
    let startFn: (m: { id: string }) => void = () => {}, stopFn: (m: { id: string }) => void = () => {}
    const stopped: string[] = []
    hookCapture({
      dirOf: (id) => `/meetings/${id}`,
      onStart: (fn) => { startFn = fn }, onStop: (fn) => { stopFn = fn },
      stopMeeting: (id) => { stopped.push(id); stopFn({ id }) },
      start: (dir, opts) => { starts.push({ dir, opts }); const f = fakeProc(); procs.push(f); return new Capture(f.proc, { startMs: opts?.startMs }) },
      join: async (dir) => { joined.push(dir) },
    })
    return { starts, procs, joined, stopped, begin: (id: string) => startFn({ id }), stop: (id: string) => stopFn({ id }) }
  }

  it('pause targets only the active session, is idempotent, and survives a helper restart', async () => {
    const r = rig()
    r.begin('paused-session')
    expect(setRecordingPaused('other', true)).toBe(false)
    expect(setRecordingPaused('paused-session', true)).toBe(true)
    expect(setRecordingPaused('paused-session', true)).toBe(true)
    expect(r.procs[0].commands).toEqual(['pause'])
    expect(recordingPaused('paused-session')).toBe(true)
    r.procs[0].exit(null, 'SIGKILL')
    expect(r.procs).toHaveLength(1)
    expect(recordingPaused('paused-session')).toBe(true)
    expect(setRecordingPaused('paused-session', false)).toBe(true)
    expect(r.procs).toHaveLength(2)
    expect(r.procs[1].commands).toEqual([])
    r.stop('paused-session')
    r.procs[1].exit(0)
    await recordingFinished('paused-session')
    expect(recordingPaused('paused-session')).toBe(false)
    expect(setRecordingPaused('paused-session', true)).toBe(false)
  })

  it('a long pause stays on the audio timeline after a crash; Finish never restarts a paused helper', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const r = rig()
    try {
      r.begin('paused-clock')
      clock.mockReturnValue(110_000)
      expect(setRecordingPaused('paused-clock', true)).toBe(true)
      clock.mockReturnValue(170_000)
      r.procs[0].exit(null, 'SIGKILL')
      expect(r.procs).toHaveLength(1)
      clock.mockReturnValue(180_000)
      expect(setRecordingPaused('paused-clock', false)).toBe(true)
      expect(r.starts[1].opts).toMatchObject({ part: 1, startMs: 80_000 })
      r.stop('paused-clock'); r.procs[1].exit(0)
      await recordingFinished('paused-clock')
      r.begin('finish-paused')
      setRecordingPaused('finish-paused', true)
      r.procs[2].exit(null, 'SIGKILL')
      r.stop('finish-paused')
      await recordingFinished('finish-paused')
      expect(r.procs).toHaveLength(3)
    } finally { clock.mockRestore() }
  })

  it('restarts into the same folder as the next part, from where the last audio ended; stopping joins the parts', async () => {
    const r = rig()
    r.begin('m1')
    expect(r.starts).toEqual([{ dir: '/meetings/m1', opts: undefined }])
    r.procs[0].out.write(encodeFrame(pcm('me', 3000, new Array(1600).fill(0.1))))
    await tick()
    r.procs[0].exit(null, 'SIGKILL')
    expect(r.starts[1]).toEqual({ dir: '/meetings/m1', opts: { part: 1, startMs: 3100 } })
    // a second crash after more audio: the meeting is stopped, and the parts are joined
    r.procs[1].out.write(encodeFrame(pcm('them', 3100, new Array(3200).fill(0.1))))
    await tick()
    r.procs[1].exit(null, 'SIGKILL')
    expect(r.starts).toHaveLength(2)
    expect(r.stopped).toEqual(['m1'])
    await recordingFinished('m1')
    expect(r.joined).toEqual(['/meetings/m1'])
  })

  it('starts with the remembered mic, and a restart uses the one chosen since', async () => {
    let chosen: string | null = 'usb:yeti'
    const starts: { opts?: CaptureOpts }[] = []
    const procs: ReturnType<typeof fakeProc>[] = []
    let startFn: (m: { id: string }) => void = () => {}, stopFn: (m: { id: string }) => void = () => {}
    hookCapture({
      dirOf: (id) => `/meetings/${id}`, onStart: (fn) => { startFn = fn }, onStop: (fn) => { stopFn = fn }, stopMeeting: () => {},
      mic: () => chosen,
      start: (_dir, opts) => { starts.push({ opts }); const f = fakeProc(); procs.push(f); return new Capture(f.proc, { startMs: opts?.startMs }) },
      join: async () => {},
    })
    startFn({ id: 'mic-restart' })
    expect(starts[0].opts).toEqual({ mic: 'usb:yeti' })
    chosen = null
    procs[0].exit(null, 'SIGKILL')
    expect(starts[1].opts).toEqual({ part: 1, startMs: expect.any(Number) })
    stopFn({ id: 'mic-restart' }); procs[1].exit(0)
    await recordingFinished('mic-restart')
  })

  it('a meeting that never crashed is not joined', async () => {
    const r = rig()
    r.begin('m2')
    r.stop('m2')
    r.procs[0].exit(0)
    await recordingFinished('m2')
    expect(r.joined).toEqual([])
  })

  it('a restarted meeting that stops normally is joined once, after the helper finished', async () => {
    const r = rig()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      r.begin('m3')
      r.procs[0].exit(null, 'SIGKILL')
    } finally { now.mockRestore() }
    expect(r.starts[1].opts).toEqual({ part: 1, startMs: 0 })
    r.stop('m3')
    r.procs[1].exit(0)
    await recordingFinished('m3')
    expect(r.joined).toEqual(['/meetings/m3'])
  })
})

describe('quitting while a recording is being finished', () => {
  it('stays busy and waits while a join runs, and is idle once it ends', async () => {
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => { release = r })
    const procs: ReturnType<typeof fakeProc>[] = []
    let startFn: (m: { id: string }) => void = () => {}, stopFn: (m: { id: string }) => void = () => {}
    hookCapture({
      dirOf: (id) => `/meetings/${id}`, onStart: (fn) => { startFn = fn }, onStop: (fn) => { stopFn = fn }, stopMeeting: (id) => stopFn({ id }),
      start: (_d, o) => { const f = fakeProc(); procs.push(f); return new Capture(f.proc, { startMs: o?.startMs }) },
      join: () => slow,
    })
    expect(recordingBusy()).toBe(false)
    startFn({ id: 'q1' })
    expect(recordingBusy()).toBe(true)
    procs[0].exit(null, 'SIGKILL')           // restart: a part to join later
    stopFn({ id: 'q1' })
    procs[1].exit(0)
    await tick(); await tick()
    // no capture is active any more, but the join is in flight
    expect(recordingBusy()).toBe(true)
    let settled = false
    const waiting = settleRecording().then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    release()
    await waiting
    expect(recordingBusy()).toBe(false)
  })

  it('gives up waiting after the cap', async () => {
    let startFn: (m: { id: string }) => void = () => {}, stopFn: (m: { id: string }) => void = () => {}
    const procs: ReturnType<typeof fakeProc>[] = []
    hookCapture({
      dirOf: (id) => `/meetings/${id}`, onStart: (fn) => { startFn = fn }, onStop: (fn) => { stopFn = fn }, stopMeeting: (id) => stopFn({ id }),
      start: () => { const f = fakeProc(); procs.push(f); return new Capture(f.proc) },
      join: () => new Promise<void>(() => {}),
    })
    startFn({ id: 'q2' })
    procs[0].exit(null, 'SIGKILL')
    stopFn({ id: 'q2' })
    procs[1].exit(0)
    const t0 = Date.now()
    await settleRecording(80)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('joining parts left behind by a quit', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'yogurt-parts-'))
  it('picks only meeting folders that still have part files', () => {
    const r = root()
    try {
      for (const d of ['a', 'b', 'c']) mkdirSync(join(r, d))
      writeFileSync(join(r, 'a', 'part.1.json'), '{"startMs":5}')
      writeFileSync(join(r, 'a', 'me.1.m4a'), '')
      writeFileSync(join(r, 'b', 'me.m4a'), '')          // finished normally
      writeFileSync(join(r, 'c', 'part.2.json'), '{"startMs":9}')
      writeFileSync(join(r, 'stray.txt'), '')
      expect(foldersToJoin(r).sort()).toEqual([join(r, 'a'), join(r, 'c')])
      expect(foldersToJoin(join(r, 'nope'))).toEqual([])
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
  it('joins each once, and one that fails does not stop the others', async () => {
    const r = root()
    try {
      for (const d of ['a', 'c']) { mkdirSync(join(r, d)); writeFileSync(join(r, d, 'part.1.json'), '{}') }
      const done: string[] = []
      await rejoinInterrupted(r, async (d) => { done.push(d); if (d.endsWith('a')) throw new Error('boom') })
      expect(done.sort()).toEqual([join(r, 'a'), join(r, 'c')])
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
  it('a meeting waiting for its join at launch is not finished until that join is, even one queued behind another', async () => {
    const r = root()
    try {
      for (const d of ['j1', 'j2']) { mkdirSync(join(r, d)); writeFileSync(join(r, d, 'part.1.json'), '{}') }
      const release: Record<string, () => void> = {}
      const all = rejoinInterrupted(r, (d) => new Promise<void>((res) => { release[d.slice(-2)] = res }))
      const state: Record<string, boolean> = { j1: false, j2: false }
      void recordingFinished('j1').then(() => { state.j1 = true })
      void recordingFinished('j2').then(() => { state.j2 = true })
      await new Promise((res) => setTimeout(res, 10))
      expect(state).toEqual({ j1: false, j2: false })
      release.j1()
      await new Promise((res) => setTimeout(res, 10))
      expect(state).toEqual({ j1: true, j2: false })
      release.j2()
      await all
      await new Promise((res) => setTimeout(res, 0))
      expect(state).toEqual({ j1: true, j2: true })
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
  it('a failed join at launch still finishes the meeting, so the player is not stuck', async () => {
    const r = root()
    try {
      mkdirSync(join(r, 'j3')); writeFileSync(join(r, 'j3', 'part.1.json'), '{}')
      await rejoinInterrupted(r, async () => { throw new Error('boom') })
      await expect(recordingFinished('j3')).resolves.toBeUndefined()
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
})

describe('waiting for a recording with a cap', () => {
  it('stops waiting after the cap, so what exists can be served', async () => {
    const r = mkdtempSync(join(tmpdir(), 'yogurt-parts-'))
    try {
      mkdirSync(join(r, 'slow')); writeFileSync(join(r, 'slow', 'part.1.json'), '{}')
      void rejoinInterrupted(r, () => new Promise<void>(() => {}))
      const t0 = Date.now()
      await recordingSettled('slow', 50)
      expect(Date.now() - t0).toBeLessThan(500)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
  it('resolves at once for a meeting with nothing to finish', async () => {
    await expect(recordingSettled('nothing-here', 10_000)).resolves.toBeUndefined()
  })
})

describe("Apple speech frames from the recorder", () => {
  it('reads volatile and final words with their track and times, and drops a malformed one', () => {
    const p = new FrameParser()
    const good = { t: 'speech', track: 'them', final: false, startMs: 1200, endMs: 2600, text: 'we should move' }
    const out = p.push(Buffer.from(JSON.stringify(good) + '\n' + JSON.stringify({ t: 'speech', track: 'us', text: 'x' }) + '\n' + JSON.stringify({ ...good, final: true, text: 'we should move the launch' }) + '\n'))
    expect(out).toEqual([good, { ...good, final: true, text: 'we should move the launch' }])
  })
  it('Capture passes them on as speech events', async () => {
    const f = fakeProc()
    const c = new Capture(f.proc)
    const got: unknown[] = []
    c.on('speech', (s) => got.push(s))
    f.out.write(Buffer.from(JSON.stringify({ t: 'speech', track: 'me', final: true, startMs: 0, endMs: 900, text: 'hello' }) + '\n'))
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ t: 'speech', track: 'me', final: true, startMs: 0, endMs: 900, text: 'hello' }])
  })
})

it("asks the helper for Apple's speech in a locale when the meeting has one", () => {
  expect(captureArgs('/m/1', { speech: 'en-US' })).toEqual(['record', '--dir', '/m/1', '--speech', 'en-US'])
  expect(captureArgs('/m/1', { part: 2, startMs: 5000, speech: 'de-DE' })).toEqual(['record', '--dir', '/m/1', '--part', '2', '--start-ms', '5000', '--speech', 'de-DE'])
  expect(captureArgs('/m/1', { speech: null })).toEqual(['record', '--dir', '/m/1'])
})

it("reads the helper's speech-off frame (Apple's speech could not run) and passes it on", async () => {
  const p = new FrameParser()
  expect(p.push(Buffer.from('{"t":"speech-off"}\n'))).toEqual([{ t: 'speech-off' }])
  const f = fakeProc()
  const c = new Capture(f.proc)
  let off = 0
  c.on('speech-off', () => off++)
  f.out.write(Buffer.from('{"t":"speech-off"}\n'))
  await new Promise((r) => setTimeout(r, 10))
  expect(off).toBe(1)
})
