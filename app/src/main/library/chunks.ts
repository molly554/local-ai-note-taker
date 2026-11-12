import type { Segment } from '../store'
import { transcriptText } from '../notes/enhance'

/**
 * A meeting's transcript cut into pieces of about 300 words, for search across meetings: big enough to hold a point
 * with what led to it, small enough that the top dozen fit in one answer. Cuts fall where the speaker changes, so a
 * chunk reads like the transcript the notes model knows ("Name: …" lines).
 */
export const CHUNK_WORDS = 300

export type Chunk = { startMs: number; endMs: number; text: string; speakers: string[] }

const who = (s: Segment) => (s.track === 'me' ? 'You' : s.speaker || 'Them')
const count = (s: string) => s.split(/\s+/).filter(Boolean).length

/** segments: the meeting's visible lines, in order (hidden echo lines are left out by the store) */
export function chunkTranscript(segments: Segment[]): Chunk[] {
  // turns, and a turn too long for one chunk as runs of its lines
  const units: Segment[][] = []
  for (const s of segments) {
    const last = units.at(-1)
    const words = last ? last.reduce((n, x) => n + count(x.text), 0) : 0
    if (last && who(last[0]) === who(s) && words + count(s.text) <= CHUNK_WORDS) last.push(s); else units.push([s])
  }
  const chunks: Segment[][] = []
  let size = 0
  for (const u of units) {
    const n = u.reduce((k, x) => k + count(x.text), 0)
    const last = chunks.at(-1)
    if (last && size + n <= CHUNK_WORDS) { last.push(...u); size += n } else { chunks.push([...u]); size = n }
  }
  return chunks.map((c) => ({
    startMs: c[0].startMs, endMs: Math.max(...c.map((s) => s.endMs)), text: transcriptText(c), speakers: [...new Set(c.map(who))],
  }))
}
