import { t } from './i18n'
import type { LiveWord } from './liveWords'
/** A transcript line as the view needs it */
type Said = { track: 'me' | 'them'; startMs: number; endMs: number; speaker: string | null; speakerColor?: number }

/** Preserve chronology: neither real speech nor live words can be crossed by an echo disclosure. */
export function echoRuns<L extends { track: string; hidden?: boolean; echoConfident?: boolean }>(lines: L[]): Array<{ echo: boolean; lines: L[] }> {
  const runs: Array<{ echo: boolean; lines: L[] }> = []
  for (const line of lines) {
    if (line.hidden && line.echoConfident) continue
    const echo = !!line.hidden, previous = runs.at(-1)
    if (previous?.echo === echo) previous.lines.push(line)
    else runs.push({ echo, lines: [line] })
  }
  return runs
}

export const echoedLinesLabel = (count: number): string => t('{count} echoed lines', { count })

/** a pause this long starts a new turn, so the time shows again */
const NEW_TURN_AFTER_MS = 30_000

/** Meeting time as m:ss, or h:mm:ss past the first hour */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Lines in a row from the same voice, so each turn shows its name and time once */
export function turns<L extends Pick<Said, 'track' | 'startMs' | 'speaker'> & { endMs?: number }>(lines: L[]): L[][] {
  const out: L[][] = []
  for (const l of lines) {
    const turn = out[out.length - 1], prev = turn?.[turn.length - 1]
    const same = prev && prev.track === l.track && prev.speaker === l.speaker && l.startMs - (prev.endMs ?? prev.startMs) < NEW_TURN_AFTER_MS
    if (same) turn.push(l)
    else out.push([l])
  }
  return out
}

/** The index of the last line that started by ms (lines sorted by start), -1 for none: a binary search, for long meetings */
export function lineAt(lines: Array<{ startMs: number }>, ms: number): number {
  let lo = 0, hi = lines.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].startMs <= ms) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** The lines that hold every word typed (any case); all of them while nothing is typed */
export function filterLines<L extends { text: string }>(lines: L[], query: string): L[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return lines
  return lines.filter((l) => { const t = l.text.toLocaleLowerCase(); return words.every((w) => t.includes(w)) })
}

/** a pause this long between lines of one voice starts a new bubble, like a new thought */
export const BUBBLE_GAP_MS = 1500

/** The lines of one turn, grouped into bubbles: lines said without a real pause between them share one */
export function bubbles<L extends Said>(lines: L[]): L[][] {
  const out: L[][] = []
  for (const l of lines) {
    const b = out[out.length - 1], prev = b?.[b.length - 1]
    if (prev && l.startMs - prev.endMs < BUBBLE_GAP_MS) b.push(l)
    else out.push([l])
  }
  return out
}

/** What one side is saying right now, not final yet (per track, as the transcript view holds it) */
export type LiveSaid = { track: 'me' | 'them'; startMs: number; endMs: number; text: string; words: LiveWord[] }

/**
 * The lines with what is being said put among them by its time, so it joins the bubble it carries on. It takes the
 * speaker of the line before it on its side (a name comes only with the final line).
 */
export function withLive<L extends Said>(lines: L[], live: LiveSaid[]): Array<L | (Said & { live: LiveSaid })> {
  const now = live.filter((x) => x.words.length).map((x) => {
    const before = lines.filter((l) => l.track === x.track && l.startMs <= x.startMs).at(-1)
    return { track: x.track, startMs: x.startMs, endMs: x.endMs, speaker: before ? before.speaker : null, speakerColor: before?.speakerColor, live: x }
  })
  if (!now.length) return lines
  return [...lines, ...now].sort((a, b) => a.startMs - b.startMs)
}

/**
 * Keys for live words, so a word that stays on screen keeps its element (and only new words fade in): the new list is
 * lined up with the old one where it best carries on (its first words may have gone into a final line).
 */
export function stableKeys(prev: string[], prevKeys: number[], next: string[], nextKey: number): { keys: number[]; next: number } {
  let at = 0, best = 0
  for (let d = 0; d < prev.length; d++) {
    if (prev[d] !== next[0]) continue
    let run = 0
    while (d + run < prev.length && run < next.length && prev[d + run] === next[run]) run++
    if (run >= best) { best = run; at = d }
  }
  let n = nextKey
  const keys = next.map((_, i) => (at + i < prevKeys.length ? prevKeys[at + i] : n++))
  return { keys, next: n }
}
