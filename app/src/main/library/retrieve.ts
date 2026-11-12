import type { Store } from '../store'
import { meetingWords, respell } from '../vocab'
import type { Library } from './store'
import type { Indexer } from './indexer'
import type { Embedder } from './embedder'
import { parseFilters, type Filters } from './filters'
import { questionKind, type Kind } from './kind'
import { fuse } from './vectors'

/** chunks given to the model for a "find" question */
export const FIND_CHUNKS = 12
/** meetings whose notes go to the model for an "across" question (newest first when dated, best first otherwise) */
export const ACROSS_MEETINGS = 12
const UNDATED_MEETINGS = 8
/** each search's list before fusing */
const EACH = 50

/** a piece the answer can use and cite: a chunk of transcript (atMs: where it starts) or a meeting's notes (atMs null) */
export type Item = { meetingId: string; title: string; startedAt: number; atMs: number | null; text: string; transcriptRange?: { startMs: number; endMs: number } }
export type Retrieved = { kind: Kind; filters: Filters; items: Item[] }

/** words that say nothing about what to find */
const STOP = new Set(('what when where which while who whom whose why how did does doing done the and for about say said says tell told was were are is that this these those with from have has had having our ours my mine you your yours they them their there here been being will would could should can may might any all some also into just like then than out get got its his her hers she him one two from please give show list want need know meeting meetings call calls talk talked talking mention mentioned think thought anything something everything really very much many more most other others same such only own over under again further once ' +
  'did not yes').split(' '))
const wordsOf = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))]

type Deps = { store: Pick<Store, 'meeting' | 'notes'>; library: Library; indexer: Pick<Indexer, 'ensure' | 'vectors'>; embedder: Pick<Embedder, 'query' | 'ready'> }

/**
 * What to answer from, for a question across meetings: dates and people (and a scope, say a folder) narrow the
 * meetings; then words (the transcript's search index) and meaning (the embedding model, once it is in) each rank
 * chunks, fused by reciprocal rank. A "find" question gets the best chunks; an "across" one each matching meeting's
 * notes. context: the question before, so a follow-up ("and the price?") is searched for what it follows on from.
 */
export async function retrieve(d: Deps, question: string, o: { now: number; scope?: string[]; context?: string }): Promise<Retrieved> {
  let meetings = d.library.finished(!!o.scope)
  if (o.scope) { const s = new Set(o.scope); meetings = meetings.filter((m) => s.has(m.id)) }
  const people = new Map(d.library.people().map((p) => [p.meetingId, p.people]))
  const whoOf = (m: typeof meetings[number]) => new Set([...m.attendees, ...(people.get(m.id) ?? [])])
  const filters = parseFilters(question, { now: o.now, names: [...new Set(meetings.flatMap((m) => [...whoOf(m)]))] })
  if (filters.from !== undefined) meetings = meetings.filter((m) => m.startedAt >= filters.from! && m.startedAt < filters.to!)
  if (filters.people.length) {
    // all the people named; any of them when no meeting has them all
    const all = meetings.filter((m) => filters.people.every((p) => whoOf(m).has(p)))
    meetings = all.length ? all : meetings.filter((m) => filters.people.some((p) => whoOf(m).has(p)))
  }
  const narrowed = !!o.scope || filters.from !== undefined || filters.people.length > 0
  const ids = meetings.map((m) => m.id)
  const byId = new Map(meetings.map((m) => [m.id, m]))
  const kind = questionKind(question, filters)
  if (!meetings.length) return { kind, filters, items: [] }
  d.indexer.ensure(ids)

  const lineAt = new Map<number, number>()
  const words = d.library.wordHits(wordsOf(filters.rest), narrowed ? ids : undefined, 300, lineAt).slice(0, EACH)
  const q = d.embedder.ready() ? await d.embedder.query(o.context ? `${o.context}\n${question}` : question) : undefined
  const near = q ? d.indexer.vectors().top(q, EACH, narrowed ? new Set(ids) : undefined) : []
  let ranked = d.library.chunks(fuse([words, near])).filter((c) => byId.has(c.meetingId))
  // questions about a speaker: their own words first
  if (filters.people.length) ranked = [...ranked.filter((c) => c.speakers.some((s) => filters.people.includes(s))), ...ranked.filter((c) => !c.speakers.some((s) => filters.people.includes(s)))]
  // narrowed to a few meetings and nothing matched the words: what was said in them
  if (!ranked.length && narrowed) ranked = ids.slice(0, FIND_CHUNKS).flatMap((id) => d.library.chunksOf(id)).slice(0, FIND_CHUNKS)

  const spelled = (meetingId: string, text: string) => { const m = d.store.meeting(meetingId); return m ? respell(text, meetingWords(m)) : text }
  const chunkItem = (c: typeof ranked[number]): Item => {
    const m = byId.get(c.meetingId)!
    // the line its words were found on, else where it starts
    return { meetingId: c.meetingId, title: m.title, startedAt: m.startedAt, atMs: lineAt.get(c.id) ?? c.startMs, text: spelled(c.meetingId, c.text), transcriptRange: { startMs: c.startMs, endMs: c.endMs } }
  }
  if (kind === 'find') {
    const items = ranked.slice(0, FIND_CHUNKS).map(chunkItem)
    // A prepared note can have typed context before it has any transcript to index.
    if (o.scope) for (const m of meetings) {
      if (items.some(i => i.meetingId === m.id)) continue
      const notes = d.store.notes(m.id)
      const text = notes.enhanced?.trim() || notes.mine.trim()
      if (text) items.push({ meetingId: m.id, title: m.title, startedAt: m.startedAt, atMs: null, text: spelled(m.id, text) })
    }
    return { kind, filters, items: items.slice(0, FIND_CHUNKS) }
  }

  // across: dated or narrowed, every matching meeting newest first; otherwise the best matches, or the latest
  const order = narrowed ? ids.slice(0, ACROSS_MEETINGS)
    : [...new Set(ranked.map((c) => c.meetingId))].concat(ids).filter((id, i, a) => a.indexOf(id) === i).slice(0, UNDATED_MEETINGS)
  if (!narrowed && !words.length) order.splice(0, order.length, ...ids.slice(0, UNDATED_MEETINGS))
  const items = order.map((id): Item => {
    const m = byId.get(id)!
    const n = d.store.notes(id)
    const notes = (n.enhanced?.trim() || n.mine.trim()).replace(/<\/?mine>/g, '')
    if (notes) return { meetingId: id, title: m.title, startedAt: m.startedAt, atMs: null, text: spelled(id, notes) }
    // no notes yet: its best chunk
    const c = ranked.find((x) => x.meetingId === id) ?? d.library.chunksOf(id)[0]
    return c ? chunkItem(c) : { meetingId: id, title: m.title, startedAt: m.startedAt, atMs: null, text: '' }
  }).filter((i) => i.text)
  return { kind, filters, items }
}
