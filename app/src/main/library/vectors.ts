/**
 * Meaning search: the embedding model's vectors, cut to the length kept and made unit length, so closeness is a dot
 * product. All of them are held in memory, a packed array per meeting, and searched by brute force: a thousand hours
 * of meetings is about 30,000 chunks, a few milliseconds.
 */

/** EmbeddingGemma's prompt for a question */
export const queryText = (q: string) => `task: search result | query: ${q}`
/** and for a piece of a meeting */
export const docText = (title: string, text: string) => `title: ${title.trim() || 'none'} | text: ${text}`

/** the first dims (a smaller embedding of their own, by how EmbeddingGemma was trained), at unit length */
export function toVector(raw: ArrayLike<number>, dims: number): Float32Array {
  const v = Float32Array.from(Array.prototype.slice.call(raw, 0, dims) as number[])
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

type Packed = { ids: number[]; data: Float32Array; dims: number }

export class VectorIndex {
  private meetings = new Map<string, Packed>()

  has(meetingId: string) { return this.meetings.has(meetingId) }
  /** a meeting's vectors, all of them (replacing what was there) */
  set(meetingId: string, rows: Array<{ id: number; vector: Float32Array }>) {
    if (!rows.length) { this.meetings.delete(meetingId); return }
    const dims = rows[0].vector.length
    const data = new Float32Array(rows.length * dims)
    rows.forEach((r, i) => data.set(r.vector.subarray(0, dims), i * dims))
    this.meetings.set(meetingId, { ids: rows.map((r) => r.id), data, dims })
  }
  drop(meetingId: string) { this.meetings.delete(meetingId) }
  clear() { this.meetings.clear() }

  /** the k chunks closest to q, closest first; within: only those meetings */
  top(q: Float32Array, k: number, within?: Set<string>): number[] {
    const best: Array<{ id: number; s: number }> = []
    for (const [meetingId, p] of this.meetings) {
      if (within && !within.has(meetingId)) continue
      const d = Math.min(p.dims, q.length)
      for (let i = 0; i < p.ids.length; i++) {
        let s = 0
        const o = i * p.dims
        for (let j = 0; j < d; j++) s += p.data[o + j] * q[j]
        if (best.length < k) { best.push({ id: p.ids[i], s }); if (best.length === k) best.sort((a, b) => b.s - a.s) }
        else if (s > best[k - 1].s) {
          // keep the list sorted: drop the worst, put this one in its place
          let at = k - 1
          while (at > 0 && best[at - 1].s < s) { best[at] = best[at - 1]; at-- }
          best[at] = { id: p.ids[i], s }
        }
      }
    }
    return best.sort((a, b) => b.s - a.s).map((b) => b.id)
  }
}

/** reciprocal rank fusion: each list adds 1 / (60 + rank); ties keep the order first seen */
export function fuse(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>()
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}
