import { tokens } from './echo'

/**
 * Lines whisper makes up when there is no speech to read. It can repeat its prompt or produce stock lines from the subtitles it learned from.
 */

/** a run of this many prompt words, and nothing else, is the prompt read back; a single name can be said for real */
const MIN_ECHO_TOKENS = 2
/** a read-back this long may carry one stray word of its own */
const LONG_ECHO_TOKENS = 4
/** whisper cuts a read-back off mid-word: the line's last word may be the start of the prompt's */
const MIN_CUT_CHARS = 3

/** The line is the prompt, or a stretch of two or more of its words in order, with no words of its own (one, in a long stretch) */
export function isPromptEcho(text: string, prompt: string): boolean {
  const t = tokens(text)
  const p = tokens(prompt)
  if (t.length < MIN_ECHO_TOKENS || t.length > p.length + 1) return false
  const same = (k: number, w: string) => w === t[k] || (k === t.length - 1 && t[k].length >= MIN_CUT_CHARS && w.startsWith(t[k]))
  // the longest stretch of the line that reads the prompt word for word
  let run = 0
  for (let a = 0; a < t.length; a++) for (let i = 0; i < p.length; i++) {
    let n = 0
    while (a + n < t.length && i + n < p.length && same(a + n, p[i + n])) n++
    run = Math.max(run, n)
  }
  return run === t.length || (run >= LONG_ECHO_TOKENS && t.length - run <= 1)
}

/** whisper's stock lines on quiet audio, from video subtitles; whole lines only */
const GUESSES = new Set([
  'you', 'thank you', 'thank you very much', 'thanks', 'thanks for watching', 'thank you for watching', 'thanks for watching bye',
  'thank you bye', 'bye', 'bye bye', 'please subscribe', 'like and subscribe', 'for more information visit www fema org',
  'subtitles by the amara org community', 'untertitel der amara org community', 'sous titres réalisés para la communauté d amara org',
  'sous titres réalisés par la communauté d amara org', 'ご視聴ありがとうございました', 'продолжение следует',
].map((x) => tokens(x).join(' ')))

/** One of whisper's stock lines for silence. Only dropped where the audio was not clearly speech: people do say thank you. */
export const isSilenceGuess = (text: string): boolean => GUESSES.has(tokens(text).join(' '))
