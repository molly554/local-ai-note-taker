/**
 * Without headphones the mic hears the other side's voice from the speakers, so the same words land on both tracks.
 * The computer's own sound is clean, so the copy on the mic track is the one dropped.
 */
export type Seg = { startMs: number; endMs: number; text: string }

const WINDOW_MS = 1500
/** a long line (8+ words) is an echo at this share of its words found in theirs; shorter lines need more (see echoMatch) */
const THRESHOLD = 0.6
const LONG_TOKENS = 8
/** 6 or 7 words: a few shared words come easily ("Sounds good, I can send it" against "yes I can send it so you have it") */
const MID_THRESHOLD = 0.8
const MID_TOKENS = 6
/** under 6 words: nearly whole, and only while the mic really echoed at that moment */
const SHORT_THRESHOLD = 0.95
/** against several of their lines at once, more of the words must be there: common words add up over a longer stretch */
const JOINED_THRESHOLD = 0.75
/** a one or two word reply ("okay", "yes") is too short to compare by words (see echoMatch for the scraps that still go) */
const MIN_TOKENS = 3

/** the speakers' tail: a mic line that starts later than this after their line ended is the person's own (a read-back) */
const TAIL_MS = 500
/**
 * What a mic line's own audio says (asr/echoDetect.ts): the mic followed their track over it (correlated); it was no
 * louder than the leak usually is (loud: little on it beyond their voice); it was nothing but their voice from the speakers (pure)
 */
export type Moment = { correlated: boolean; loud: boolean; pure: boolean }
/**
 * Echo in this meeting: heard in the audio (asr/echoDetect.ts); whether the mic echoed in the 2 s window holding a
 * moment; and what a line's own span says (undefined before the room's lag is known)
 */
export type EchoCheck = { echo?: boolean; correlatedAt?: (ms: number) => boolean; over?: (startMs: number, endMs: number) => Moment | undefined }

/** Words, lowercased and without punctuation. Text without spaces (Japanese, Chinese) is compared by character. */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return words.flatMap((w) => (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w) ? [...w] : [w]))
}

/** Share of the shorter text's words that the other has too (each word counted as often as it appears in both) */
export function tokenOverlap(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b)
  if (!ta.length || !tb.length) return 0
  const left = new Map<string, number>()
  for (const w of tb) left.set(w, (left.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of ta) { const n = left.get(w) ?? 0; if (n > 0) { shared++; left.set(w, n - 1) } }
  return shared / Math.min(ta.length, tb.length)
}

/** How many of a's words b has too (each counted as often as it appears in both) */
export function sharedTokens(a: string, b: string): number {
  const left = new Map<string, number>()
  for (const w of tokens(b)) left.set(w, (left.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of tokens(a)) { const n = left.get(w) ?? 0; if (n > 0) { shared++; left.set(w, n - 1) } }
  return shared
}

/** a line the audio calls pure still needs this many of its words in their line at that moment, at the long-line share */
const PURE_SHARED = 3

/** sounds that are not words: a mic line of only these says nothing worth keeping */
const FILLER = /^(um+|uh+|hm+|mm+|mhm|mm-hmm|uh-huh|erm|ah|oh|eh|huh)$/
/** the person's own short replies: never hidden, however their words fit in theirs */
const ACK = new Set(['yeah', 'yes', 'yep', 'yup', 'no', 'nope', 'right', 'okay', 'ok', 'sure', 'exactly', 'true', 'agreed', 'fine', 'great', 'good', 'thanks', 'thank', 'you', 'please', 'sorry', 'absolutely', 'definitely', 'indeed', 'correct', 'cool', 'perfect', 'hi', 'hello', 'bye', 'alright', 'well', 'so', 'and', 'but', 'i', 'me', 'too', 'also'])

/**
 * Is this me segment a copy of what them said around the same time? A long line (8+ words) at 60% of its words, a
 * 6 or 7 word line at 80%, a shorter one only nearly whole and only while the mic really echoed then (the person's own
 * "I can do that" shares words with theirs too easily). A long line is also judged against their lines together: whisper
 * cuts the two tracks at different pauses, so the echo of one sentence can straddle two lines.
 */
function echoMatch(m: Seg, them: Seg[], at: (ms: number) => boolean, over?: EchoCheck['over']): false | 'high' | 'uncertain' {
  // an echo is their voice on the mic while the line was said: a copy said a second later (a read-back) is the person's own.
  // The line's own audio decides where it can: the mic followed their track over the line, or in the window holding it
  // while the person talked over them; and never when the mic was far louder than the leak (the person's own words,
  // even if their track carries a copy of them)
  const span = over?.(m.startMs, m.endMs)
  const inWindow = at(m.startMs) || at((m.startMs + m.endMs) / 2) || at(m.endMs)
  if (span ? !(span.correlated || inWindow) || !span.loud : !inWindow) return false
  const mine = tokens(m.text)
  // nothing on the mic but their voice from the speakers, and their line at that moment has most of its words: an echo at a
  // lower word bar than below. Never on the audio alone: a person who speaks as quietly as the leak sounds much the same.
  if (span?.pure && mine.length >= MIN_TOKENS && !mine.every((w) => ACK.has(w)) && them.some((o) => o.startMs < m.endMs && o.endMs > m.startMs && sharedTokens(m.text, o.text) >= PURE_SHARED && tokenOverlap(m.text, o.text) >= THRESHOLD)) return 'high'
  // their lines this one could be a copy of: overlapping in time, and begun before their line (and the speakers' tail) ended
  const near = them.filter((o) => m.startMs <= o.endMs + WINDOW_MS && m.endMs >= o.startMs - WINDOW_MS && m.startMs < o.endMs + TAIL_MS)
  if (mine.length < MIN_TOKENS) {
    // too short to compare by words: only filler, or a scrap of a line of theirs said at the same moment ("role is" while
    // they said "my role is to design", "minutes" over their "minutes"); a short reply of the person's own ("yeah", "right") stays
    if (mine.length && mine.every((w) => FILLER.test(w))) return near.length > 0 ? 'uncertain' : false
    if (!mine.length || mine.every((w) => ACK.has(w))) return false
    const over = them.filter((o) => m.startMs < o.endMs + 300 && m.endMs > o.startMs - 300)
    return over.some((o) => { const t = tokens(o.text); return mine.every((w) => t.includes(w)) }) ? 'uncertain' : false
  }
  if (mine.length < MID_TOKENS) return near.some((o) => tokens(o.text).length >= MIN_TOKENS && tokenOverlap(m.text, o.text) >= SHORT_THRESHOLD) ? 'high' : false
  const needed = mine.length < LONG_TOKENS ? MID_THRESHOLD : THRESHOLD
  const overlap = Math.max(0, ...near.filter(o => tokens(o.text).length >= MIN_TOKENS).map(o => tokenOverlap(m.text, o.text)))
  if (overlap >= needed) return overlap >= MID_THRESHOLD ? 'high' : 'uncertain'
  const joined = tokenOverlap(m.text, near.map(o => o.text).join(' '))
  return mine.length >= LONG_TOKENS && near.length > 1 && joined >= JOINED_THRESHOLD ? joined >= SHORT_THRESHOLD ? 'high' : 'uncertain' : false
}

/** A long line of theirs on the mic almost word for word at the same moment (kept for the record; the audio decides whether echo is present) */
const VERBATIM_TOKENS = 5
const VERBATIM = 0.8
export function isVerbatimCopy(m: Seg, them: Seg[]): boolean {
  if (tokens(m.text).length < VERBATIM_TOKENS) return false
  return them.some((o) => m.startMs <= o.endMs + WINDOW_MS && m.endMs >= o.startMs - WINDOW_MS && tokens(o.text).length >= VERBATIM_TOKENS && tokenOverlap(m.text, o.text) >= VERBATIM)
}

const always = () => true

/** Pure audio spans or strong word matches can be quiet; weak matches remain reviewable. */
export function echoConfidence(m: Seg, them: Seg[], o: EchoCheck = {}): false | 'high' | 'uncertain' {
  return o.echo ? echoMatch(m, them, o.correlatedAt ?? always, o.over) : false
}

/**
 * The `me` segments that are not a copy of something `them` said within 1.5 s of it. o.echo: the meeting has echo
 * (asr/echoDetect.ts heard their voice on the mic). Without that, nothing is dropped: with headphones a short reply that
 * repeats their words is the person's own, and dropping it loses their words.
 */
export function dropEcho<T extends Seg>(me: T[], them: Seg[], o: EchoCheck = {}): T[] {
  if (!o.echo) return me
  const at = o.correlatedAt ?? always
  return me.filter((m) => !echoMatch(m, them, at, o.over))
}

/**
 * After the meeting, over the whole saved transcript: the ids of me lines that are echoes of them lines. Live, a me line
 * is checked only against their lines that had arrived by then; here every line is in, whenever it arrived. Only with
 * echo heard in the audio; the lines found are hidden, never deleted.
 */
export function echoIds<T extends Seg & { id: number; track: 'me' | 'them' }>(segs: T[], o: EchoCheck = {}): number[] {
  const them = segs.filter((s) => s.track === 'them')
  if (!them.length || !o.echo) return []
  const at = o.correlatedAt ?? always
  return segs.filter((s) => s.track === 'me' && echoMatch(s, them, at, o.over)).map((s) => s.id)
}
