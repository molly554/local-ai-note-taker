import type { Segment } from '../store'
import type { Track } from '../capture'
import type { Chunk } from './chunker'
import { languageName } from './appleSpeech'
import { tokens } from './echo'
import { isPromptEcho, isSilenceGuess } from './hallucination'

/** What a chunk turns into: lines on meeting time. The meeting and the speaker are added where they are saved. */
export type Line = Omit<Segment, 'id' | 'meetingId' | 'speaker'> & {
  /** whisper's words with their times (live view only, never saved) */
  words?: Array<{ text: string; startMs: number; endMs: number }>
}
/** partial: a quick greedy reading of a chunk still being spoken (shown, never saved); the default is the careful beam search */
export type Transcribe = (c: Chunk, o?: { partial?: boolean }) => Promise<Line[]>

/** 16 kHz mono 16-bit wav, built in memory */
export function wavBytes(samples: Float32Array): Buffer {
  const n = samples.length * 2
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 32768 : 32767)), 44 + i * 2)
  return b
}

/** Empty, or the same few words over and over: whisper lost its way, usually because the language was wrong */
export function isGarbled(text: string): boolean {
  if (!text.trim()) return true
  const ts = tokens(text)
  return ts.length >= 8 && new Set(ts).size / ts.length <= 0.25
}

/** Noise tags and silence guesses whisper writes when nothing was said */
const NOISE = /^[[(♪*].*[\])♪*]$|^[♪\s.]+$/

type Verbose = {
  detected_language?: string; language?: string; detected_language_probability?: number
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number; words?: Array<{ word: string; start: number; end: number }> }>
}

type Opts = {
  /** where the server is; starts it if need be */
  url: () => Promise<string>
  /** a request failed: bring the server back (true) or give up (false). Asked on each failed call; the server decides how often it agrees. */
  recover?: (reason: 'gone' | 'timeout', used?: string) => Promise<boolean>
  /** how long one request may take before the server is taken to be hung (default: requestTimeoutMs) */
  timeoutMs?: number
  fetchFn?: typeof fetch
  /** the language a chunk was heard in, and how much was said in it (the notes are written in the main one) */
  /** locked: the track already had a language lock when this chunk was heard (one odd chunk before the lock should change nothing) */
  onLanguage?: (track: Track, language: string, chars: number, locked: boolean) => void
  /** the meeting's names and companies (vocab.ts whisperPrompt), read for each chunk since people join during a call */
  prompt?: () => string
  /** the language to tell whisper on every chunk (English only), read each time so a change counts from the next one; none: detect */
  language?: () => string | undefined
}

/** a chunk takes well under its own length to transcribe: 4 times that (at least 30 s) means the server hung */
export const requestTimeoutMs = (samples: number): number => Math.max(30_000, Math.round((samples / 16) * 4))

const MIN_LOCK_PROB = 0.8
const MIN_CLEAR_MS = 300
const MIN_LOCK_TOKENS = 2

/**
 * Sends chunks to whisper-server's /inference. Auto-detecting the language on every short chunk flips on short sentences,
 * so once a track has been heard clearly in one language, later chunks on it are told that language.
 * An empty or garbled answer on a locked track asks again with the language open; the lock goes only if that hears something.
 */
export function createTranscriber(o: Opts): Transcribe {
  const fetchFn = o.fetchFn ?? fetch
  const locked: Partial<Record<Track, string>> = {}

  const call = async (c: Chunk, language: string, partial = false, guess = !partial): Promise<{ lines: Line[]; text: string; language: string; prob: number }> => {
    let used: string | undefined
    const prompt = o.prompt?.() ?? ''
    // under 300 ms of clearly loud audio: a faint sound, where whisper's stock lines are made up
    const faint = c.clearMs !== undefined && c.clearMs < MIN_CLEAR_MS
    const send = async () => {
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(wavBytes(c.samples))], { type: 'audio/wav' }), 'chunk.wav')
      form.set('response_format', 'verbose_json')
      form.set('language', language)
      form.set('temperature', '0.0')
      form.set('no_timestamps', 'false')
      // a partial is read once, greedily: a few times faster than the server's beam search, good enough for a first look
      if (partial) { form.set('beam_size', '1'); form.set('best_of', '1') }
      // a language guess nobody reads costs a second pass of the encoder, about a third of the request
      if (!guess) form.set('no_language_probabilities', 'true')
      if (prompt) form.set('prompt', prompt)
      used = await o.url()
      return fetchFn(`${used}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(o.timeoutMs ?? requestTimeoutMs(c.samples.length)) })
    }
    let res: Response
    try { res = await send() } catch (err) {
      // the server crashed or hung: one chance to bring it back, then the chunk is tried again
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'gone'
      if (!(await o.recover?.(reason, used).catch(() => false))) throw err
      res = await send()
    }
    if (!res.ok) throw new Error(`whisper-server answered ${res.status}`)
    const body = (await res.json()) as Verbose
    const lines: Line[] = []
    for (const s of body.segments ?? []) {
      const text = s.text.replace(/\s+/g, ' ').trim()
      if (!text || NOISE.test(text)) continue
      if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) continue
      // read back from the prompt, or a stock line over a faint sound: whisper had nothing to read
      if (isPromptEcho(text, prompt) || (faint && isSilenceGuess(text))) continue
      const words = s.words?.map((w) => ({ text: w.word, startMs: Math.round(c.startMs + w.start * 1000), endMs: Math.round(c.startMs + w.end * 1000) }))
      lines.push({ track: c.track, startMs: Math.round(c.startMs + s.start * 1000), endMs: Math.round(c.startMs + s.end * 1000), text, ...(words?.length ? { words } : {}) })
    }
    return { lines, text: lines.map((l) => l.text).join(' '), language: body.detected_language ?? body.language ?? 'auto', prob: body.detected_language_probability ?? 0 }
  }

  return async (c, opt) => {
    const forced = o.language?.()
    if (forced) {
      // the person said which language it is: nothing to detect, lock or look at again
      const r = await call(c, forced, !!opt?.partial, false)
      if (!opt?.partial && r.text.trim() && !isGarbled(r.text)) o.onLanguage?.(c.track, languageName(forced), r.text.length, true)
      return r.lines
    }
    const had = locked[c.track]
    // a partial neither locks the language nor counts towards it: the finished line does
    if (opt?.partial) return (await call(c, had ?? 'auto', true)).lines
    let r = await call(c, had ?? 'auto')
    if (had && isGarbled(r.text)) {
      const open = await call(c, 'auto')
      // nothing in any language (VAD found no speech, or only made-up lines): the lock stays
      if (open.text.trim()) { delete locked[c.track]; r = open }
    }
    if (r.language !== 'auto' && r.text.trim() && !isGarbled(r.text)) o.onLanguage?.(c.track, r.language, r.text.length, !!had)
    if (!locked[c.track] && r.language !== 'auto' && r.prob >= MIN_LOCK_PROB && !isGarbled(r.text) && tokens(r.text).length >= MIN_LOCK_TOKENS) locked[c.track] = r.language
    return r.lines
  }
}
