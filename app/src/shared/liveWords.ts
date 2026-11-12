/**
 * The live words of one track: what has been heard but is not in a final line yet, word by word on meeting time.
 * Quick readings (whisper's greedy pass, Apple's volatile words) arrive over and over for the same stretch, and finals
 * land for stretches that don't line up with them. Placing every word on time means a new reading replaces exactly the
 * words it reads again, and a final takes away exactly the words it stands for: nothing shows twice, nothing heard vanishes.
 */
export type LiveWord = {
  text: string; startMs: number; endMs: number
  /** joins the word before it without a space (punctuation whisper gives as its own word) */
  glue?: boolean
  /** its time is a guess, spread over a reading that gave no time per word (Apple's volatile words) */
  rough?: boolean
}
export type Heard = { startMs: number; endMs: number; text: string; words?: Array<{ text: string; startMs: number; endMs: number }> }

const mid = (w: LiveWord) => (w.startMs + w.endMs) / 2
/** whisper's special tokens ([_BEG_], <|en|>) are not words */
const SPECIAL = /^\[_|^<\|/

/** about how long a word takes to say (some 180 words a minute) */
const WORD_MS = 330

/**
 * Words spread over a stretch by their length, so a long word gets more of it. A stretch much longer than its words
 * (Apple's volatile reading starts where its last final ended, often a silence ago) has them at its end, at a speaking pace.
 */
function spread(text: string, from: number, endMs: number): LiveWord[] {
  const parts = text.split(/\s+/).filter(Boolean)
  const total = parts.reduce((n, p) => n + p.length, 0) || 1
  const startMs = Math.max(from, endMs - parts.length * WORD_MS)
  let at = startMs
  return parts.map((p, i) => {
    const end = i === parts.length - 1 ? endMs : at + ((endMs - startMs) * p.length) / total
    const w = { text: p, startMs: Math.round(at), endMs: Math.round(end), rough: true as const }
    at = end
    return w
  })
}

/** a reading's words: its own times where it has them, else spread over the reading */
export function wordsOf(h: Heard): LiveWord[] {
  if (!h.words?.length) return spread(h.text, h.startMs, h.endMs)
  const out: LiveWord[] = []
  for (const w of h.words) {
    const text = w.text.trim()
    if (!text || SPECIAL.test(text)) continue
    // one time for several words: Apple's volatile reading is a single run
    if (/\s/.test(text)) { out.push(...spread(text, w.startMs, w.endMs)); continue }
    out.push({ text, startMs: w.startMs, endMs: w.endMs, ...(out.length && !/^\s/.test(w.text) ? { glue: true } : {}) })
  }
  return out
}

export const joinWords = (ws: LiveWord[]): string => ws.map((w, i) => (i === 0 || w.glue ? w.text : ' ' + w.text)).join('')

/** the words `drop` says a new reading reads again go, its words come in; kept in time order */
export function replaceWords(cur: LiveWord[], incoming: LiveWord[], drop: (w: LiveWord) => boolean): LiveWord[] {
  return [...cur.filter((w) => !drop(w)), ...incoming].sort((a, b) => a.startMs - b.startMs)
}

const norm = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))
/** a guessed time can be this far off before a rough word is taken to be before the final */
const ROUGH_SLACK_MS = 500

/**
 * How many of the first rough words say the end of the final's text (words may differ a little between the two readers):
 * a word-level edit distance where the final may start anywhere. The longest stretch that matches well wins.
 */
function covered(rough: LiveWord[], finalText: string): number {
  const f = finalText.split(/\s+/).map(norm).filter(Boolean).slice(-40)
  const r = rough.slice(0, 60).map((w) => norm(w.text))
  if (!f.length || !r.length) return 0
  let prev = new Array<number>(f.length + 1).fill(0)
  let best = 0, bestScore = 0
  for (let i = 1; i <= r.length; i++) {
    const row = [i]
    for (let j = 1; j <= f.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (same(r[i - 1], f[j - 1]) ? 0 : 1))
    const dist = row[f.length], score = i - 2 * dist
    if (dist <= Math.floor(i / 4) && (i >= 2 || f.length === 1) && score > bestScore) { best = i; bestScore = score }
    prev = row
  }
  return best
}

/**
 * What is left once a final line up to `endMs` is shown: every word said before it goes. Timed words go by time; rough
 * words go as far as they say the final's last words, or by their guessed time (with some slack) when they say nothing like it.
 */
export function afterFinal(ws: LiveWord[], f: { endMs: number; text: string }): LiveWord[] {
  const exact = ws.filter((w) => !w.rough && mid(w) >= f.endMs)
  const rough = ws.filter((w) => w.rough)
  const byText = covered(rough, f.text)
  const byTime = rough.filter((w) => mid(w) < f.endMs - ROUGH_SLACK_MS).length
  return [...exact, ...rough.slice(byText || byTime)].sort((a, b) => a.startMs - b.startMs)
}
