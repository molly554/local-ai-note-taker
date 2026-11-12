import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { isFake } from './paths'
import { fakeAudioDuration, fakeCaptureProc, joinFakeParts } from './fakeCapture'
import type { RecordingStart } from './meeting'
import { createCrashPolicy } from './crashPolicy'
import { helperFile } from '../shared/platform'

/**
 * Recording a meeting: yogurt-audio writes me.m4a and them.m4a (Windows and Linux: me.ogg and them.ogg, Ogg Opus) into the meeting's folder and streams
 * 16 kHz mono audio for transcription, sound levels and warnings on stdout.
 * Each message is a JSON line; a pcm line is followed by n float32 samples (little-endian).
 */
export type Track = 'me' | 'them'
/**
 * no-mic: microphone access is off; no-system-audio: the computer's sound can't be recorded; device-changed: a device switch, recording goes on;
 * mic-gone: the mic the person chose went away (or can't be recorded from), and Auto took over
 */
export type WarnCode = 'no-system-audio' | 'device-changed' | 'no-mic' | 'mic-gone'
/** Transcription trouble, shown like the recorder's hints: some audio could not be transcribed / no speech model yet / the queue overflowed */
export type TranscribeWarn = 'transcribe-failed' | 'no-speech-model' | 'falling-behind'
const WARN_CODES: readonly string[] = ['no-system-audio', 'device-changed', 'no-mic', 'mic-gone'] satisfies WarnCode[]
/** The mic recording now, after each start or switch: uid null is Auto (the Mac's default input), name the device's */
export type MicInUse = { uid: string | null; name: string | null }
export type Level = { me: number; them: number }
/** Apple's on-device speech (macOS 26): words as they are said (final false, they still change) and once settled, on meeting time */
export type SpeechFrame = { t: 'speech'; track: Track; final: boolean; startMs: number; endMs: number; text: string
  /** each word's time (a volatile reading is one run for all its words) */
  words?: Array<{ text: string; startMs: number; endMs: number }> }
export type Frame =
  | { t: 'pcm'; track: Track; ms: number; samples: Float32Array }
  | ({ t: 'level' } & Level)
  | { t: 'warn'; code: WarnCode }
  | SpeechFrame
  /** Apple's speech could not run for this recording (not installed, failed to start): whisper's own readings take over */
  | { t: 'speech-off' }
  /** Apple's speech is listening on these tracks (one may be missing: whisper's readings cover the other) */
  | { t: 'speech-ready'; tracks: Track[] }
  | ({ t: 'mic' } & MicInUse)

export function encodeFrame(f: Frame): Buffer {
  if (f.t !== 'pcm') return Buffer.from(JSON.stringify(f) + '\n')
  const head = Buffer.from(JSON.stringify({ t: 'pcm', track: f.track, ms: f.ms, n: f.samples.length }) + '\n')
  const body = Buffer.alloc(f.samples.length * 4)
  for (let i = 0; i < f.samples.length; i++) body.writeFloatLE(f.samples[i], i * 4)
  return Buffer.concat([head, body])
}

/** Turns stdout chunks, cut anywhere, back into messages */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)
  private pending: { track: Track; ms: number; n: number } | null = null

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: Frame[] = []
    for (;;) {
      if (this.pending) {
        const bytes = this.pending.n * 4
        if (this.buf.length < bytes) break
        const samples = new Float32Array(this.pending.n)
        for (let i = 0; i < this.pending.n; i++) samples[i] = this.buf.readFloatLE(i * 4)
        out.push({ t: 'pcm', track: this.pending.track, ms: this.pending.ms, samples })
        this.buf = this.buf.subarray(bytes)
        this.pending = null
        continue
      }
      const nl = this.buf.indexOf(10)
      if (nl < 0) break
      const line = this.buf.subarray(0, nl).toString()
      this.buf = this.buf.subarray(nl + 1)
      const msg = readLine(line)
      if (!msg) continue
      if (msg.t === 'pcm') this.pending = msg
      else out.push(msg)
    }
    return out
  }
}

type Header = { t: 'pcm'; track: Track; ms: number; n: number } | Exclude<Frame, { t: 'pcm' }>
function readLine(line: string): Header | null {
  let m: Record<string, unknown>
  try { m = JSON.parse(line) } catch { console.error('capture: unreadable line', line.slice(0, 200)); return null }
  if (m.t === 'pcm' && (m.track === 'me' || m.track === 'them') && Number.isInteger(m.n) && (m.n as number) >= 0)
    return { t: 'pcm', track: m.track, ms: Number(m.ms), n: m.n as number }
  if (m.t === 'level') return { t: 'level', me: Number(m.me) || 0, them: Number(m.them) || 0 }
  if (m.t === 'warn' && typeof m.code === 'string' && WARN_CODES.includes(m.code)) return { t: 'warn', code: m.code as WarnCode }
  if (m.t === 'speech-off') return { t: 'speech-off' }
  const orNull = (x: unknown) => (typeof x === 'string' ? x : x === null ? null : undefined)
  if (m.t === 'mic' && orNull(m.uid) !== undefined && orNull(m.name) !== undefined) return { t: 'mic', uid: orNull(m.uid)!, name: orNull(m.name)! }
  if (m.t === 'speech-ready' && Array.isArray(m.tracks)) return { t: 'speech-ready', tracks: m.tracks.filter((x): x is Track => x === 'me' || x === 'them') }
  if (m.t === 'speech' && (m.track === 'me' || m.track === 'them') && typeof m.final === 'boolean' && typeof m.text === 'string' && Number.isFinite(Number(m.startMs)) && Number.isFinite(Number(m.endMs)))
    return { t: 'speech', track: m.track, final: m.final, startMs: Number(m.startMs), endMs: Number(m.endMs), text: m.text, ...speechWords(m.words) }
  return null
}

/** The parts of a child process Capture uses, so tests and fake mode can stand in */
export interface CaptureProc {
  stdout: Readable
  stdin: Writable
  on(e: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface Capture {
  on(e: 'pcm', fn: (track: Track, ms: number, samples: Float32Array) => void): this
  on(e: 'level', fn: (lv: Level) => void): this
  on(e: 'warn', fn: (code: WarnCode) => void): this
  on(e: 'speech', fn: (s: SpeechFrame) => void): this
  on(e: 'speech-off', fn: () => void): this
  on(e: 'speech-ready', fn: (tracks: Track[]) => void): this
  on(e: 'mic', fn: (m: MicInUse) => void): this
  on(e: 'ended', fn: (e: { crashed: boolean }) => void): this
}

export class Capture extends EventEmitter {
  private stopping = false
  private exited = false
  private done: Promise<void>
  private end: number

  /** startMs: where meeting time stands when this run starts (a restart picks up after the one before) */
  constructor(private proc: CaptureProc, opts: { startMs?: number } = {}) {
    super()
    this.end = opts.startMs ?? 0
    const parser = new FrameParser()
    proc.stdout.on('data', (d: Buffer) => {
      for (const f of parser.push(d)) {
        if (f.t === 'pcm') { this.end = Math.max(this.end, f.ms + f.samples.length / 16); this.emit('pcm', f.track, f.ms, f.samples) }
        else if (f.t === 'level') this.emit('level', { me: f.me, them: f.them })
        else if (f.t === 'speech') this.emit('speech', f)
        else if (f.t === 'speech-off') this.emit('speech-off')
        else if (f.t === 'speech-ready') this.emit('speech-ready', f.tracks)
        else if (f.t === 'mic') this.emit('mic', { uid: f.uid, name: f.name })
        else this.emit('warn', f.code)
      }
    })
    // the helper going away closes its stdin; writing to it then must not throw
    proc.stdin.on('error', () => {})
    this.done = new Promise((resolve) => {
      proc.on('exit', (code) => {
        if (this.exited) return
        this.exited = true
        this.emit('ended', { crashed: !this.stopping || code !== 0 })
        resolve()
      })
    })
  }

  /** meeting time, in ms, at the end of the last audio heard */
  get endMs(): number { return Math.round(this.end) }

  private send(cmd: string): boolean {
    if (this.exited || this.proc.stdin.destroyed || !this.proc.stdin.writable) return false
    try { this.proc.stdin.write(cmd + '\n'); return true } catch { return false }
  }
  pause() { return !this.stopping && this.send('pause') }
  resume() { return !this.stopping && this.send('resume') }
  /** records from this mic from now on (null: Auto), without stopping */
  setMic(uid: string | null) { return !this.stopping && this.send(uid ? `mic ${uid}` : 'mic auto') }

  /** Finishes both files; a helper that hangs is killed after 10 s (the files stay playable up to the last 5 s flush) */
  async stop(): Promise<void> {
    if (this.exited) return
    this.stopping = true
    this.send('stop')
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 10_000)
    await this.done
    clearTimeout(timer)
  }
}

export function audioHelperPath(): string {
  const file = helperFile('audio', process.platform)
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', file),
    join(__dirname, '../../resources/bin', file),
    join(__dirname, '../../../resources/bin', file),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

/** Apple's word times, when the helper sent them and they make sense */
function speechWords(x: unknown): { words?: SpeechFrame['words'] } {
  if (!Array.isArray(x)) return {}
  const words = x.filter((w): w is { text: string; startMs: number; endMs: number } => !!w && typeof w.text === 'string' && Number.isFinite(w.startMs) && Number.isFinite(w.endMs)).slice(0, 500)
  return words.length ? { words: words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })) } : {}
}

/** A restart is the next part of the same meeting's files, starting at meeting time startMs; speech: Apple's live words in this locale; mic: the chosen mic's UID (none: Auto) */
export type CaptureOpts = { part?: number; startMs?: number; speech?: string | null; mic?: string | null }
export const captureArgs = (dir: string, o?: CaptureOpts): string[] =>
  ['record', '--dir', dir, ...(o?.part ? ['--part', String(o.part), '--start-ms', String(Math.round(o.startMs ?? 0))] : []), ...(o?.speech ? ['--speech', o.speech] : []), ...(o?.mic ? ['--mic', o.mic] : [])]

export function startCapture(meetingDir: string, o?: CaptureOpts): Capture {
  mkdirSync(meetingDir, { recursive: true })
  if (isFake()) return new Capture(fakeCaptureProc(meetingDir, o?.startMs ?? 0, { speech: !!o?.speech, part: o?.part, mic: o?.mic }), { startMs: o?.startMs })
  // straight from Yogurt, never through a shell: Windows leaves the helper's parent's process tree (Yogurt) out of the call audio
  const child = spawn(audioHelperPath(), captureArgs(meetingDir, o), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.on('data', (d: Buffer) => console.error('yogurt-audio:', d.toString().trim()))
  // a missing or broken helper is a crash, not an exception in the main process
  child.on('error', (e) => { console.error('yogurt-audio failed to start', e); child.emit('exit', null, null) })
  return new Capture(child, { startMs: o?.startMs })
}

/** Stitches the parts of a crashed-and-restarted recording into one me.m4a and one them.m4a on meeting time */
export function joinParts(meetingDir: string): Promise<void> {
  if (isFake()) { joinFakeParts(meetingDir); return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const child = spawn(audioHelperPath(), ['join', '--dir', meetingDir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (d: Buffer) => console.error('yogurt-audio join:', d.toString().trim()))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`yogurt-audio join exited with ${code}`))))
  })
}

/** Finish any retained parts, then read the real audio end before an explicit append session. */
export async function prepareAppend(meetingDir: string): Promise<{ part: number; startMs: number }> {
  mkdirSync(meetingDir, { recursive: true })
  await joinParts(meetingDir)
  const durationMs = isFake() ? fakeAudioDuration(meetingDir) : await new Promise<number>((resolve, reject) => {
    execFile(audioHelperPath(), ['inspect', '--dir', meetingDir], { timeout: 15_000, maxBuffer: 16_384, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return }
      try {
        const value = JSON.parse(stdout).durationMs
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid audio duration')
        resolve(Math.ceil(value))
      } catch (e) { reject(e) }
    })
  })
  return { part: 1, startMs: durationMs }
}

let active: Capture | null = null
/** The capture of the meeting being recorded, for transcription to listen to */
export const activeCapture = (): Capture | null => active

/** What the recording widget hears about: levels, warnings, and the helper's restarts */
export type RecordingEvent =
  | { t: 'level'; me: number; them: number }
  | { t: 'warn'; code: WarnCode | TranscribeWarn }
  | { t: 'hiccup' }
  | { t: 'gave-up' }
  | { t: 'paused'; meetingId: string; paused: boolean; at: number }
const recordingListeners: Array<(e: RecordingEvent) => void> = []
export const onRecordingEvent = (fn: (e: RecordingEvent) => void) => { recordingListeners.push(fn); return () => { const i = recordingListeners.indexOf(fn); if (i >= 0) recordingListeners.splice(i, 1) } }
export const tell = (e: RecordingEvent) => { for (const fn of [...recordingListeners]) { try { fn(e) } catch (err) { console.error('recording listener failed', err) } } }
/** Called with each capture that starts for a meeting, a restarted one too, so listeners can follow it */
const captureListeners: Array<(c: Capture, meetingId: string) => void> = []
export const onCaptureStart = (fn: (c: Capture, meetingId: string) => void) => { captureListeners.push(fn); return () => { const i = captureListeners.indexOf(fn); if (i >= 0) captureListeners.splice(i, 1) } }

/**
 * The meeting being recorded: its folder, how many restarts it has had (each restart is a part), and its "files are
 * final" promise, made when it starts so a hook that runs before ours on Stop still waits for the recorder
 */
let session: { id: string; dir: string; parts: number; paused: boolean; startedAt: number; restart?: () => void; join: (dir: string) => Promise<void>; settled: Promise<void>; settle: () => void } | null = null
export const recordingPaused = (id: string): boolean => session?.id === id && session.paused
/** Pause the current helper without ending its files, transcript session or meeting. */
export function setRecordingPaused(id: string, paused: boolean): boolean {
  if (!session || session.id !== id || !active) return false
  if (session.paused === paused) return true
  if (!paused && session.restart) {
    // A crashed paused helper stays off until the person explicitly resumes.
    const restart = session.restart
    session.paused = false
    try { restart(); delete session.restart } catch { session.paused = true; return false }
  } else if (!(paused ? active.pause() : active.resume())) return false
  session.paused = paused
  if (paused) tell({ t: 'level', me: 0, them: 0 })
  tell({ t: 'paused', meetingId: id, paused, at: Date.now() })
  return true
}
const finished = new Map<string, Promise<void>>()
/** Resolves when the meeting's files are final: the helper has finished and any parts are joined. Read the audio after this. */
export const recordingFinished = (id: string): Promise<void> => finished.get(id) ?? Promise.resolve()

/** Ends the recording: stops the helper, then joins the parts if it ever restarted */
function finish(): Promise<void> {
  const s = session, c = active
  active = null; session = null
  if (!s) return Promise.resolve()
  inFlight.add(s.settled)
  void (async () => {
    try { await c?.stop(); if (s.parts > 0) await s.join(s.dir) } catch (e) { console.error('finishing the recording failed', e) }
  })().finally(s.settle)
  return s.settled
}

/** Stops and joins still running, so quitting can wait for them */
const inFlight = new Set<Promise<void>>()
/** A recording is on, or its files are still being finished */
export const recordingBusy = (): boolean => !!active || inFlight.size > 0
/** Finishes any recording on and waits for every join in flight; after capMs it gives up so quitting is never stuck */
export async function settleRecording(capMs = 30_000): Promise<void> {
  void finish()
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<void>((r) => { timer = setTimeout(r, capMs) })
  await Promise.race([Promise.all([...inFlight]), cap])
  clearTimeout(timer)
}

/** Meeting folders that still hold part files: a quit or crash came before their join finished */
export function foldersToJoin(meetingsDir: string): string[] {
  try {
    return readdirSync(meetingsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && readdirSync(join(meetingsDir, d.name)).some((f) => /^part\.\d+\.json$/.test(f)))
      .map((d) => join(meetingsDir, d.name))
  } catch { return [] }
}
/**
 * The retry at start-up: join those folders once; one failing never stops the others. Each meeting (its folder's
 * name) counts as still recording until its own join is done, so nothing reads its files mid-rewrite.
 */
export async function rejoinInterrupted(meetingsDir: string, join: (dir: string) => Promise<void> = joinParts): Promise<void> {
  const dirs = foldersToJoin(meetingsDir)
  const done = new Map<string, () => void>()
  for (const dir of dirs) {
    const id = basename(dir)
    const p = new Promise<void>((r) => done.set(dir, r)).finally(() => { inFlight.delete(p); if (finished.get(id) === p) finished.delete(id) })
    finished.set(id, p)
    inFlight.add(p)
  }
  for (const dir of dirs) {
    try { await join(dir) } catch (e) { console.error('joining left-over parts failed', dir, e) } finally { done.get(dir)!() }
  }
}

/** recordingFinished, but never waiting more than capMs: a stuck join still lets what exists be read */
export async function recordingSettled(id: string, capMs = 30_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([recordingFinished(id), new Promise<void>((r) => { timer = setTimeout(r, capMs) })])
  clearTimeout(timer)
}

/** Records while a meeting is recording: starts with it, stops with it, restarts once if the helper dies */
export function hookCapture(p: {
  dirOf: (id: string) => string
  onStart: (fn: (m: Pick<RecordingStart, 'id' | 'resume'>) => void) => unknown
  onStop: (fn: (m: { id: string }) => void) => unknown
  /** ends the meeting when recording can't go on */
  stopMeeting: (id: string) => void
  /** the locale Apple's live speech listens in for this meeting, null for whisper only */
  speech?: (meetingId: string) => string | null
  /** the mic the person chose (null: Auto), read at each start so a restart keeps a switch made meanwhile */
  mic?: () => string | null
  /** for tests */
  start?: (dir: string, o?: CaptureOpts) => Capture
  join?: (dir: string) => Promise<void>
}) {
  const begin = p.start ?? startCapture
  p.onStart((m) => {
    if (active) return
    const dir = p.dirOf(m.id)
    let settle!: () => void
    const settled: Promise<void> = new Promise<void>((r) => { settle = r }).finally(() => { inFlight.delete(settled); if (finished.get(m.id) === settled) finished.delete(m.id) })
    const s: NonNullable<typeof session> = session = { id: m.id, dir, parts: m.resume?.part ?? 0, paused: false, startedAt: Date.now() - (m.resume?.startMs ?? 0), join: p.join ?? joinParts, settled, settle }
    finished.set(m.id, settled)
    const speech = p.speech?.(m.id) ?? null
    const micOpt = () => { const mic = p.mic?.() ?? null; return mic ? { mic } : {} }
    const policy = createCrashPolicy({
      // the new helper writes the next part, with meeting time carried on from where the last audio ended
      restart: () => {
        const prev = active!
        const restart = () => {
          const startMs = Math.max(prev.endMs, Date.now() - s.startedAt)
          attach(begin(dir, { part: s.parts + 1, startMs, ...(speech ? { speech } : {}), ...micOpt() })); s.parts++
        }
        if (s.paused) s.restart = restart
        else restart()
      },
      hiccup: () => tell({ t: 'hiccup' }),
      giveUp: () => { tell({ t: 'gave-up' }); void finish(); p.stopMeeting(m.id) },
    })
    const attach = (c: Capture) => {
      active = c
      c.on('warn', (code) => { console.warn('capture warning', code); tell({ t: 'warn', code }) })
      c.on('level', (lv) => tell({ t: 'level', me: s.paused ? 0 : lv.me, them: s.paused ? 0 : lv.them }))
      c.on('ended', (e) => {
        // a capture that was stopped on purpose or replaced is not ours to judge
        if (active !== c) return
        if (!e.crashed) { active = null; session = null; s.settle(); return }
        console.error('capture ended unexpectedly', m.id)
        policy.ended(e)
      })
      for (const fn of [...captureListeners]) { try { fn(c, m.id) } catch (err) { console.error('capture listener failed', err) } }
    }
    const base = m.resume ? { part: m.resume.part, startMs: m.resume.startMs, ...(speech ? { speech } : {}) } : speech ? { speech } : undefined
    const mic = micOpt()
    attach(begin(dir, base || mic.mic ? { ...base, ...mic } : undefined))
  })
  p.onStop((m) => { if (session?.id === m.id) void finish() })
}
