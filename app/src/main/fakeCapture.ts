import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { encodeFrame, type CaptureProc, type Track } from './capture'
import { fakeMicList } from './fake'

/**
 * Fake mode: plays e2e/fixtures/meeting-me.wav and meeting-them.wav as if the mic and the computer heard them,
 * at real-time speed and through the same framed stream as the helper, then silence. On stop it writes what it
 * played as me.wav and them.wav (on meeting time), so the player has something to play.
 */
const RATE = 16000
const CHUNK = RATE / 10

function fixturesDir(): string {
  const candidates = [join(__dirname, '../../e2e/fixtures'), join(__dirname, '../../../e2e/fixtures')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/** 16-bit PCM mono wav → float samples */
export function readWav(file: string): Float32Array {
  const b = readFileSync(file)
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(Math.min(size, b.length - off - 8) / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  return new Float32Array(0)
}

const rms = (xs: Float32Array) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / (xs.length || 1))
/** float samples → 16-bit PCM mono wav */
export function wavOf(chunks: Float32Array[], rate = RATE): Buffer {
  const n = chunks.reduce((a, c) => a + c.length, 0)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  let off = 44
  for (const c of chunks) for (const x of c) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), off); off += 2 }
  return b
}

const level = (xs: Float32Array) => Math.max(0, Math.min(1, (20 * Math.log10(rms(xs) + 1e-9) + 60) / 60))

/**
 * fake Apple speech (YOGURT_FAKE_SPEECH=1), sent the way SpeechTranscriber sends it: a volatile reading as one run that
 * starts where the track's last final ended, then the settled phrase from its first word, a run a word.
 */
const SPEECH: Array<{ track: Track; at: number; finalMs: number; text: string }> = [
  { track: 'me', at: 500, finalMs: 4000, text: 'Hi, thanks for joining. Can we go over the launch plan for next week?' },
  { track: 'them', at: 5200, finalMs: 4000, text: 'Sure. The site goes live on Tuesday, and the email goes out on Wednesday morning.' },
  { track: 'me', at: 10_500, finalMs: 2400, text: 'Great. Who is writing the release notes?' },
  { track: 'them', at: 13_300, finalMs: 2000, text: 'She will send a draft by Friday.' },
]

export function fakeCaptureProc(meetingDir: string, startMs = 0, o: { speech?: boolean; part?: number; mic?: string | null } = {}): CaptureProc {
  const ev = new EventEmitter()
  const stdout = new PassThrough(), stdin = new PassThrough()
  const audio: Record<Track, Float32Array> = {
    me: readWav(join(fixturesDir(), 'meeting-me.wav')),
    them: readWav(join(fixturesDir(), 'meeting-them.wav')),
  }
  const started = Date.now()
  if (o.part) writeFileSync(join(meetingDir, `part.${o.part}.json`), JSON.stringify({ startMs }))
  let sent = 0, paused = false, ended = false
  // like the helper: the chosen mic if it is here, else Auto; each start or switch says which mic records
  const here = (uid: string) => fakeMicList().some((m) => m.uid === uid)
  let mic: string | null = o.mic && here(o.mic) ? o.mic : null
  let micName: string | null = null
  const reportMic = () => {
    const list = fakeMicList()
    micName = (mic ? list.find((m) => m.uid === mic) : list.find((m) => m.default))?.name ?? null
    stdout.write(encodeFrame({ t: 'mic', uid: mic, name: micName }))
  }
  /** the chosen mic unplugged: Auto; on Auto, a new default is followed */
  const checkMics = () => {
    if (mic && !here(mic)) { mic = null; stdout.write(encodeFrame({ t: 'warn', code: 'mic-gone' })); reportMic() }
    else if (!mic && fakeMicList().find((m) => m.default)?.name !== micName) reportMic()
  }
  setImmediate(() => { if (!ended) reportMic() })
  /** fake Apple speech: which volatile readings (and finals) have gone out, by phrase and step; where each track's last final ended */
  const spoken = new Set<string>()
  const settled: Record<Track, number> = { me: startMs, them: startMs }
  const SPEECH_STEP_MS = 700
  const speechAt = (ms: number) => {
    if (!o.speech) return
    for (const e of SPEECH) {
      const since = ms - e.at
      if (since < SPEECH_STEP_MS) continue
      const words = e.text.split(' ')
      if (since >= e.finalMs) {
        const k = `${e.track}:${e.at}:final`
        if (spoken.has(k)) continue
        spoken.add(k)
        const from = startMs + e.at, per = (e.finalMs - 500) / words.length
        const runs = words.map((w, i) => ({ text: (i ? ' ' : '') + w, startMs: Math.round(from + i * per), endMs: Math.round(from + (i + 1) * per) }))
        stdout.write(encodeFrame({ t: 'speech', track: e.track, final: true, startMs: from, endMs: from + e.finalMs - 500, text: e.text, words: runs }))
        settled[e.track] = from + e.finalMs - 500
        continue
      }
      const step = Math.floor(since / SPEECH_STEP_MS), k = `${e.track}:${e.at}:${step}`
      if (spoken.has(k)) continue
      spoken.add(k)
      const text = words.slice(0, Math.min(words.length - 1, step * 3)).join(' ')
      stdout.write(encodeFrame({ t: 'speech', track: e.track, final: false, startMs: settled[e.track], endMs: startMs + ms, text, words: [{ text: ' ' + text, startMs: settled[e.track], endMs: startMs + ms }] }))
    }
  }
  // what was recorded, from meeting time 0 (a restarted part starts with the silence before it)
  const played: Record<Track, Float32Array[]> = { me: [new Float32Array(o.part ? 0 : Math.round((startMs / 1000) * RATE))], them: [new Float32Array(o.part ? 0 : Math.round((startMs / 1000) * RATE))] }

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return
    ended = true; clearInterval(timer)
    for (const track of ['me', 'them'] as const) writeFileSync(join(meetingDir, o.part ? `${track}.${o.part}.wav` : `${track}.wav`), wavOf(played[track]))
    stdout.end()
    setImmediate(() => ev.emit('exit', code, signal))
  }
  const timer = setInterval(() => {
    checkMics()
    // everything due by now, in 100 ms chunks, so slow timers don't slow the audio
    while (sent + CHUNK <= ((Date.now() - started) * RATE) / 1000) {
      const ms = startMs + (sent / RATE) * 1000
      sent += CHUNK
      // like the helper: a pause is silence in the files, so file time stays meeting time
      if (paused) { played.me.push(new Float32Array(CHUNK)); played.them.push(new Float32Array(CHUNK)); continue }
      const lv = { me: 0, them: 0 }
      for (const track of ['me', 'them'] as const) {
        const src = audio[track], from = sent - CHUNK
        const samples = new Float32Array(CHUNK)
        if (from < src.length) samples.set(src.subarray(from, Math.min(sent, src.length)))
        lv[track] = level(samples)
        played[track].push(samples)
        stdout.write(encodeFrame({ t: 'pcm', track, ms, samples }))
      }
      stdout.write(encodeFrame({ t: 'level', ...lv }))
      speechAt(ms - startMs)
    }
  }, 50)

  stdin.on('data', (d: Buffer) => {
    for (const cmd of d.toString().split('\n')) {
      if (cmd === 'pause') paused = true
      else if (cmd === 'resume') paused = false
      else if (cmd.startsWith('mic ')) {
        const uid = cmd.slice(4).trim()
        if (uid === 'auto' || here(uid)) mic = uid === 'auto' ? null : uid
        reportMic()
      }
      else if (cmd === 'stop') {
        finish(0, null)
      }
    }
  })

  const proc: CaptureProc = {
    stdout, stdin,
    on: (e, fn) => { ev.on(e, fn); return proc },
    kill: (signal = 'SIGTERM') => { finish(null, signal); return true },
  }
  return proc
}

/** Fake mode uses lossless PCM parts so preservation assertions can compare the original bytes. */
function pcmBytes(file: string): Buffer {
  const b = readFileSync(file)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 36, 40) !== 'data' || b.readUInt32LE(24) !== RATE || b.readUInt16LE(34) !== 16) throw new Error('Unreadable fixture audio')
  const bytes = b.readUInt32LE(40)
  if (bytes > b.length - 44 || bytes % 2) throw new Error('Truncated fixture audio')
  return b.subarray(44, 44 + bytes)
}
export function fakeAudioDuration(dir: string): number {
  const files = readdirSync(dir)
  if (files.some((file) => /^part\.\d+\.json$/.test(file) || /^(me|them)\.\d+\.wav$/.test(file))) throw new Error('Unjoined recording parts')
  return Math.ceil(Math.max(0, ...(['me', 'them'] as const).map((track) => {
    const file = join(dir, `${track}.wav`)
    return existsSync(file) ? pcmBytes(file).length / (RATE * 2) * 1000 : 0
  })))
}
export function joinFakeParts(dir: string): void {
  const files = readdirSync(dir)
  const parts = files.filter((file) => /^part\.\d+\.json$/.test(file)).map((file) => {
    const startMs = Number(JSON.parse(readFileSync(join(dir, file), 'utf8')).startMs)
    if (!Number.isFinite(startMs) || startMs < 0) throw new Error('Invalid recording timeline')
    return { file, part: Number(file.split('.')[1]), startMs }
  }).sort((a, b) => a.part - b.part)
  // Read every part before replacing either main track.
  const tracks = (['me', 'them'] as const).map((track) => {
    const main = join(dir, `${track}.wav`)
    let bytes = existsSync(main) ? pcmBytes(main) : Buffer.alloc(0)
    const used: string[] = []
    for (const part of parts) {
      const file = join(dir, `${track}.${part.part}.wav`)
      if (!existsSync(file)) continue
      const next = pcmBytes(file), start = Math.round(part.startMs / 1000 * RATE) * 2
      if (bytes.length < start + next.length) bytes = Buffer.concat([bytes, Buffer.alloc(Math.max(0, start - bytes.length)), next])
      used.push(file)
    }
    return { main, bytes, used }
  })
  for (const { main, bytes, used } of tracks) {
    if (!used.length) continue
    const header = wavOf([]); header.writeUInt32LE(36 + bytes.length, 4); header.writeUInt32LE(bytes.length, 40)
    const temp = main + '.joined'
    writeFileSync(temp, Buffer.concat([header, bytes])); renameSync(temp, main)
    used.forEach((file) => unlinkSync(file))
  }
  for (const part of parts) unlinkSync(join(dir, part.file))
}
