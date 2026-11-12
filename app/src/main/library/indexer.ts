import type { Store } from '../store'
import type { Queue } from '../notes/queue'
import type { Library } from './store'
import type { Embedder } from './embedder'
import { chunkTranscript } from './chunks'
import { VectorIndex } from './vectors'

/** chunks embedded per request: a stop waits for one batch at most (well under a second) */
const BATCH = 8

/**
 * Keeps the library in step with the meetings, as an `index` job in the model queue (last in line, never while a
 * meeting records): finished meetings that are new or changed are chunked again (plain code, instant), then chunks
 * without a vector are embedded, newest meetings first. Asked for after notes are written, at launch, after an import
 * and when the embedding model lands. The vectors for search are kept in memory and follow what changed.
 */
export function createIndexer(o: { store: Pick<Store, 'meeting' | 'segments'>; library: Library; embedder: Embedder; queue: Pick<Queue, 'enqueue'> }) {
  const index = new VectorIndex()
  /** meetings whose vectors changed since the index was read: read again on the next search */
  const dirty = new Set<string>()
  let loaded = false

  /** a meeting's chunks made now (also from search, for a meeting not reached yet) */
  const chunk = (meetingId: string, signature: string) => {
    const m = o.store.meeting(meetingId)
    if (!m) return
    const chunks = chunkTranscript(o.store.segments(meetingId))
    const spoke = chunks.flatMap((c) => c.speakers).filter((s) => s !== 'You' && s !== 'Them')
    const people = [...new Set([...m.attendees.map((a) => a.name.trim()).filter(Boolean), ...spoke])]
    o.library.setChunks(meetingId, signature, people, chunks)
    dirty.add(meetingId)
  }

  /** one pass: stale meetings chunked, then everything without a vector embedded; a stop ends it between batches */
  const pass = async (signal: AbortSignal) => {
    for (const s of o.library.stale()) chunk(s.meetingId, s.signature)
    if (!o.embedder.ready()) return
    const model = o.embedder.model()
    while (!signal.aborted) {
      const todo = o.library.unembedded(model, BATCH)
      if (!todo.length) return
      const vectors = await o.embedder.docs(todo)
      if (!vectors) return
      // chunks made again meanwhile (a changed meeting) are gone: their rows no longer exist, so nothing is written
      todo.forEach((c, i) => { o.library.setVector(c.id, model, vectors[i]); dirty.add(c.meetingId) })
    }
  }

  return {
    pass,
    /** a pass through the queue; resolves when it is done */
    schedule: () => o.queue.enqueue(pass, 'index').catch((e) => console.error('indexing meetings failed', e)),
    /** chunks for these meetings now if they have none yet (search reaching a meeting the pass has not) */
    ensure(meetingIds: string[]) {
      for (const id of meetingIds) {
        const m = o.store.meeting(id)
        if (m && (m.state !== 'done' && m.state !== 'stopped')) chunk(id, 'live')
      }
      for (const s of o.library.stale()) if (meetingIds.includes(s.meetingId)) chunk(s.meetingId, s.signature)
    },
    /** the vectors for search, up to date with what was embedded */
    vectors(): VectorIndex {
      const model = o.embedder.model()
      if (!loaded) {
        loaded = true; dirty.clear()
        const by = new Map<string, Array<{ id: number; vector: Float32Array }>>()
        for (const v of o.library.vectors(model)) { const l = by.get(v.meetingId) ?? []; l.push(v); by.set(v.meetingId, l) }
        for (const [id, rows] of by) index.set(id, rows)
      } else if (dirty.size) {
        const ids = [...dirty]
        dirty.clear()
        const by = new Map<string, Array<{ id: number; vector: Float32Array }>>(ids.map((id) => [id, []]))
        for (const v of o.library.vectors(model, ids)) by.get(v.meetingId)?.push(v)
        for (const [id, rows] of by) index.set(id, rows)
      }
      return index
    },
    /** the meeting was deleted, or moved to the Trash */
    forget(meetingId: string) { index.drop(meetingId); dirty.delete(meetingId) },
    /** the meeting came back from the Trash: its vectors are read again on the next search */
    restored(meetingId: string) { dirty.add(meetingId) },
    /** meetings came in from a backup: read every vector again, and index what is new */
    refresh() { loaded = false; index.clear(); return this.schedule() },
  }
}
export type Indexer = ReturnType<typeof createIndexer>
