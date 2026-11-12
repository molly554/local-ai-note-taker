import type { Track } from '../capture'

/**
 * Cuts each track's audio into pieces of speech for the transcriber.
 * Whisper drops lines on long audio, so it only ever gets short pieces cut at pauses.
 * A chunk ends at 1 s of silence, or at 15 s, cut at the quietest 100 ms in its last 2 s.
 * While someone keeps talking, the open chunk so far goes out as a partial every 0.8 s (shown at once, never saved).
 */
export type Chunk = {
  track: Track; /** meeting time of the first sample */ startMs: number; samples: Float32Array
  /** how much of it is clearly speech (well over the track's noise floor): under 300 ms is a faint sound, not someone talking */
  clearMs?: number
}

const RATE = 16000
const WIN = RATE / 10 // 100 ms
/** 1 s: at 600 ms a room conversation came out as 1-2 s scraps, which whisper reads worse than whole sentences */
const SILENCE_WINS = 10
const KEEP_SILENCE_WINS = 2 // a little quiet at the end so the last word isn't clipped
const MAX_WINS = 150
const SEARCH_WINS = 20
const MIN_VOICED_WINS = 3
/**
 * The track's noise floor is its quietest tenth over the last minute. Speech is a window louder than 1.5x that, kept
 * between -56 dB and -34 dB: a quiet headset (AMI speech sits near 0.005) and a noisy room both work with a ratio, not a level.
 * The gate only has to find where someone may be talking; whisper's own speech detector (Silero VAD) decides what is
 * speech. At 3x the quietest fifth, a standup heard through a laptop's mic lost two thirds of its words: with people
 * talking all the time the quietest fifth is already speech, and the people across the table sat under 3x it.
 */
const FLOOR_SHARE = 0.1
const SPEECH_FACTOR = 1.5
/**
 * Clearly speech: 3x a level of 3x the noise floor (that level kept within the same limits). On a solo test note whisper wrote "Thank you." over
 * faint sounds whose loudest windows stayed under this (-51 dB and below), while the quietest real sentence had several over it (-43 dB).
 */
const LOUD_FACTOR = 3
const CLEAR_FACTOR = 3
const MIN_THRESHOLD = 0.0015
const MAX_THRESHOLD = 0.02
const START_THRESHOLD = 0.004
const HISTORY_WINS = 600
const WARMUP_WINS = 20
/** a jump in meeting time bigger than this is a pause or a restart, not the next frame */
const GAP_MS = 200
/**
 * partials: one every 0.8 s of an open chunk, once it holds 0.8 s of speech. Always the whole chunk (15 s at most): a reading
 * of only its end would cut a word in two at the edge, and whisper reads a 30 s window whatever it is given, so it costs little more.
 */
const PARTIAL_EVERY_WINS = 8
const PARTIAL_MIN_VOICED_WINS = 8

type Win = { samples: Float32Array; rms: number; voiced: boolean; clear: boolean }
type State = {
  /** meeting time where the next frame should start, or null before the first */
  next: number | null
  /** samples not yet a whole window */
  rest: Float32Array
  /** the chunk being collected: its start and its windows */
  open: { startMs: number; wins: Win[] } | null
  /** meeting time of the window being filled */
  winStart: number
  /** loudness of the last minute of windows, for the noise floor */
  history: number[]
}

const rmsOf = (xs: Float32Array) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i] * xs[i]; return Math.sqrt(s / (xs.length || 1)) }
const join = (wins: Win[]) => {
  const out = new Float32Array(wins.length * WIN)
  wins.forEach((w, i) => out.set(w.samples, i * WIN))
  return out
}

/** onPartial: the open chunk so far, from its start */
export function chunker(onChunk: (c: Chunk) => void, onPartial?: (c: Chunk) => void) {
  const tracks: Record<Track, State> = {
    me: { next: null, rest: new Float32Array(0), open: null, winStart: 0, history: [] },
    them: { next: null, rest: new Float32Array(0), open: null, winStart: 0, history: [] },
  }

  const emit = (track: Track, startMs: number, wins: Win[]) => {
    if (wins.filter((w) => w.voiced).length < MIN_VOICED_WINS) return
    onChunk({ track, startMs, samples: join(wins), clearMs: wins.filter((w) => w.clear).length * 100 })
  }

  /** a chunk ended: trailing quiet beyond a little is cut off */
  const close = (track: Track, st: State) => {
    const o = st.open
    st.open = null
    if (!o) return
    let end = o.wins.length
    while (end > 0 && !o.wins[end - 1].voiced) end--
    emit(track, o.startMs, o.wins.slice(0, Math.min(o.wins.length, end + KEEP_SILENCE_WINS)))
  }

  /** how loud speech may be (voiced) and clearly is (clear) on this track, judged against what it sounds like when nobody talks */
  const thresholdsOf = (st: State, rms: number): { voiced: number; clear: number } => {
    st.history.push(rms)
    if (st.history.length > HISTORY_WINS) st.history.shift()
    if (st.history.length < WARMUP_WINS) return { voiced: START_THRESHOLD, clear: START_THRESHOLD * CLEAR_FACTOR }
    const floor = [...st.history].sort((a, b) => a - b)[Math.floor(st.history.length * FLOOR_SHARE)]
    const level = (factor: number) => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * factor))
    return { voiced: level(SPEECH_FACTOR), clear: level(LOUD_FACTOR) * CLEAR_FACTOR }
  }

  const addWindow = (track: Track, st: State, w: Win) => {
    const voiced = w.voiced
    if (!st.open) {
      if (voiced) st.open = { startMs: st.winStart, wins: [w] }
      st.winStart += 100
      return
    }
    st.open.wins.push(w)
    st.winStart += 100
    const wins = st.open.wins
    let quiet = 0
    while (quiet < wins.length && !wins[wins.length - 1 - quiet].voiced) quiet++
    if (quiet >= SILENCE_WINS) return close(track, st)
    // still talking: what there is so far, for a quick first reading. Not the mic while the other side talks: without
    // headphones that is mostly their voice from the speakers, which the finished line will be checked for.
    if (onPartial && voiced && wins.length % PARTIAL_EVERY_WINS === 0 && wins.filter((v) => v.voiced).length >= PARTIAL_MIN_VOICED_WINS && !(track === 'me' && tracks.them.open)) {
      onPartial({ track, startMs: st.open.startMs, samples: join(wins), clearMs: wins.filter((v) => v.clear).length * 100 })
    }
    if (wins.length >= MAX_WINS) {
      // the quietest of the last 2 s; the first of equals, so a flat run cuts as early as it may
      let cut = wins.length - SEARCH_WINS
      for (let i = cut; i < wins.length; i++) if (wins[i].rms < wins[cut].rms) cut = i
      const head = wins.slice(0, cut + 1)
      st.open = { startMs: st.open.startMs + head.length * 100, wins: wins.slice(cut + 1) }
      emit(track, st.open.startMs - head.length * 100, head)
      if (!st.open.wins.length) st.open = null
    }
  }

  const flushTrack = (track: Track) => {
    const st = tracks[track]
    close(track, st)
    st.rest = new Float32Array(0)
    st.next = null
  }

  return {
    /** ms is meeting time of samples[0]; frames may be any size */
    push(track: Track, ms: number, samples: Float32Array) {
      const st = tracks[track]
      if (st.next !== null && Math.abs(ms - st.next) > GAP_MS) flushTrack(track)
      if (st.next === null) { st.winStart = ms; st.rest = new Float32Array(0) }
      st.next = ms + samples.length / 16
      let buf = samples
      if (st.rest.length) { buf = new Float32Array(st.rest.length + samples.length); buf.set(st.rest); buf.set(samples, st.rest.length) }
      let i = 0
      for (; i + WIN <= buf.length; i += WIN) {
        const w = buf.slice(i, i + WIN)
        const rms = rmsOf(w)
        const t = thresholdsOf(st, rms)
        addWindow(track, st, { samples: w, rms, voiced: rms >= t.voiced, clear: rms >= t.clear })
      }
      st.rest = buf.slice(i)
    },
    /** the meeting ended: whatever is being collected goes out */
    flush() { flushTrack('me'); flushTrack('them') },
    /** someone on this track is mid-sentence: a chunk is being collected */
    isOpen: (track: Track) => !!tracks[track].open,
  }
}
