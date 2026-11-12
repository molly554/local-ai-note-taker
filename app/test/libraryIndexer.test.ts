import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { createEmbedder } from '../src/main/library/embedder'
import { createIndexer } from '../src/main/library/indexer'
import { createQueue } from '../src/main/notes/queue'
import { FakeEngine } from '../src/main/notes/fake'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function rig(o: { embedPath?: string; recording?: () => boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-indexer-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const library = new Library(store.db)
  const engine = new FakeEngine()
  const embedded: string[][] = []
  const spy = { embed: async (p: string, texts: string[]) => { embedded.push(texts); await new Promise((res) => setTimeout(res, 1)); return engine.embed(p, texts) }, unloadEmbed: async () => {} }
  let path = o.embedPath
  const embedder = createEmbedder({ engine: spy, modelPath: () => path, id: 'gemma', dims: 64 })
  const queue = createQueue({ recording: o.recording ?? (() => false), smallMac: false })
  const indexer = createIndexer({ store, library, embedder, queue })
  return { store, library, embedder, indexer, embedded, setPath: (p: string) => { path = p } }
}
const meeting = (s: Store, title: string, lines: string[], state: 'done' | 'recording' = 'done') => {
  const m = s.createMeeting({ title, startedAt: 1000, endedAt: 2000, eventId: null, app: null, attendees: [{ name: 'Tarun Shah', email: null }], state })
  s.addSegments(lines.map((text, i) => ({ meetingId: m.id, track: i % 2 ? 'them' as const : 'me' as const, startMs: i * 1000, endMs: i * 1000 + 900, text, speaker: i % 2 ? 'Bo Park' : null })))
  return m
}

describe('indexing meetings for chat across them', () => {
  it('chunks every finished meeting, then embeds the chunks with the meeting title, in the background', async () => {
    const r = rig({ embedPath: '/m/e.gguf' })
    const a = meeting(r.store, 'Pricing', ['The price is twenty dollars', 'Too much for us'])
    meeting(r.store, 'Live one', ['still going'], 'recording')
    await r.indexer.schedule()
    expect(r.library.chunksOf(a.id).map((c) => c.text)).toEqual(['You: The price is twenty dollars\nBo Park: Too much for us'])
    expect(r.library.people()).toEqual([{ meetingId: a.id, people: ['Tarun Shah', 'Bo Park'] }])
    expect(r.embedded.flat()).toEqual(['title: Pricing | text: You: The price is twenty dollars\nBo Park: Too much for us'])
    const v = r.library.vectors(r.embedder.model())
    expect(v).toHaveLength(1)
    expect(v[0].vector).toHaveLength(64)
    // nothing changed: a second pass does nothing
    await r.indexer.schedule()
    expect(r.embedded).toHaveLength(1)
  })

  it('without the embedding model yet, meetings are still chunked (word search works); vectors come once it lands', async () => {
    const r = rig()
    const a = meeting(r.store, 'Pricing', ['The price is twenty dollars'])
    await r.indexer.schedule()
    expect(r.library.chunksOf(a.id)).toHaveLength(1)
    expect(r.embedded).toEqual([])
    r.setPath('/m/e.gguf')
    await r.indexer.schedule()
    expect(r.library.vectors(r.embedder.model())).toHaveLength(1)
  })

  it('a meeting whose lines change is chunked and embedded again; its search vectors follow', async () => {
    const r = rig({ embedPath: '/m/e.gguf' })
    const a = meeting(r.store, 'Pricing', ['The price is twenty dollars'])
    await r.indexer.schedule()
    expect(r.indexer.vectors().top((await r.embedder.query('price'))!, 5)).toHaveLength(1)
    r.store.addSegments([{ meetingId: a.id, track: 'me', startMs: 9000, endMs: 9500, text: 'And the launch is Tuesday', speaker: null }])
    await r.indexer.schedule()
    const ids = r.library.chunksOf(a.id).map((c) => c.id)
    expect(r.indexer.vectors().top((await r.embedder.query('launch'))!, 5)).toEqual(ids)
  })

  it('a meeting in the Trash is out of the search vectors; restored, it is back', async () => {
    const r = rig({ embedPath: '/m/e.gguf' })
    const a = meeting(r.store, 'Pricing', ['The price is twenty dollars'])
    await r.indexer.schedule()
    const q = (await r.embedder.query('price'))!
    r.store.trashMeeting(a.id, 1); r.indexer.forget(a.id)
    expect(r.indexer.vectors().top(q, 5)).toEqual([])
    r.store.restoreMeeting(a.id); r.indexer.restored(a.id)
    expect(r.indexer.vectors().top(q, 5)).toHaveLength(1)
    // read fresh (a launch): the Trash is left out
    r.store.trashMeeting(a.id, 2)
    await r.indexer.refresh()
    expect(r.indexer.vectors().top(q, 5)).toEqual([])
  })

  it('stops between batches when other work comes, keeping what it embedded; it picks up there', async () => {
    const r = rig({ embedPath: '/m/e.gguf' })
    for (let i = 0; i < 20; i++) meeting(r.store, `Meeting ${i}`, [`line ${i}`])
    const ac = new AbortController()
    const run = r.indexer.pass(ac.signal)
    await new Promise((res) => setTimeout(res, 0))
    ac.abort()
    await run
    const some = r.library.vectors(r.embedder.model()).length
    expect(some).toBeGreaterThan(0)
    expect(some).toBeLessThan(20)
    await r.indexer.schedule()
    expect(r.library.vectors(r.embedder.model())).toHaveLength(20)
  })
})
