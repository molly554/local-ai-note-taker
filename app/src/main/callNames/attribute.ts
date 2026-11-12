/**
 * Who said a line from the other side, from what the call app showed while it was said. Never a guess: a name only
 * when the app marked that one person as talking for most of the line, or when the call has just one other person.
 * Anything else (nobody marked, several at once, the app not read) is Them.
 */

/** One reading of the call app, at meeting time (capture latency and the app's own lag already taken off) */
export type CallSample = {
  ms: number
  /** who the app marks as talking right now */
  speaking: string[]
  /** everyone the app shows in the call, the person using Yogurt too */
  participants: string[]
  /** the person using Yogurt, when the app says which one they are ("(me)", "You") */
  me: string | null
  /** false: the app could not be read at this moment (no window, no permission) */
  ok?: boolean
}

/** a reading stands until the next one, but never longer than this: a stuck app never keeps naming someone */
export const HOLD_MS = 2000
/** a name needs more than this share of the line */
const MOST = 0.5

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()

type Opts = { /** the person's own name in Settings, and the Mac's: never a name for the other side */ myNames?: string[] }

const isMe = (name: string, s: CallSample, o: Opts) => {
  const n = norm(name)
  return (s.me != null && norm(s.me) === n) || (o.myNames ?? []).some((m) => m && norm(m) === n)
}

/** who the other side was at one reading, or null when it can't be told */
function whoAt(s: CallSample, o: Opts): string | null {
  if (s.ok === false) return null
  const people = [...new Map(s.participants.map((p) => [norm(p), p])).values()]
  // one other person in the call: the call's sound can only be them, whoever the app marks
  if (people.length === 2) {
    const mine = people.filter((p) => isMe(p, s, o))
    if (mine.length === 1) return people.find((p) => !isMe(p, s, o))!
  }
  const others = [...new Set(s.speaking.filter((p) => !isMe(p, s, o)))]
  return others.length === 1 ? others[0] : null
}

/** The name for a line of the other side spoken over [startMs, endMs], or null for Them */
export function nameFor(span: { startMs: number; endMs: number }, samples: CallSample[], o: Opts = {}): string | null {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a.ms - b.ms)
  const at = (i: number) => [sorted[i].ms, Math.min(sorted[i + 1]?.ms ?? Infinity, sorted[i].ms + HOLD_MS)] as const
  // a line too short to measure: whoever it was the moment it started
  if (span.endMs <= span.startMs) {
    for (let i = sorted.length - 1; i >= 0; i--) { const [a, b] = at(i); if (a <= span.startMs) return span.startMs < b ? whoAt(sorted[i], o) : null }
    return null
  }
  const time = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    const [a, b] = at(i)
    const overlap = Math.min(b, span.endMs) - Math.max(a, span.startMs)
    if (overlap <= 0) continue
    const who = whoAt(sorted[i], o)
    if (who) time.set(who, (time.get(who) ?? 0) + overlap)
  }
  const [best] = [...time].sort((x, y) => y[1] - x[1])
  return best && best[1] > MOST * (span.endMs - span.startMs) ? best[0] : null
}

/** Everyone seen in the call but the person using Yogurt, each once, in the order first seen */
export function othersIn(samples: CallSample[], o: Opts = {}): string[] {
  const out = new Map<string, string>()
  for (const s of samples) for (const p of s.participants) if (!isMe(p, s, o) && !out.has(norm(p))) out.set(norm(p), p)
  // someone marked "me" in a later reading is never one of the others
  const me = new Set(samples.flatMap((s) => (s.me ? [norm(s.me)] : [])))
  return [...out].filter(([k]) => !me.has(k)).map(([, v]) => v)
}
