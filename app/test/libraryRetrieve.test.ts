import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { createEmbedder } from '../src/main/library/embedder'
import { createIndexer } from '../src/main/library/indexer'
import { retrieve } from '../src/main/library/retrieve'
import { toVector } from '../src/main/library/vectors'
import { createQueue } from '../src/main/notes/queue'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

// Wednesday 4 November 2026, 15:30
const now = new Date(2026, 10, 4, 15, 30).getTime()
const daysAgo = (n: number) => now - n * 86_400_000

/** a stand-in embedding model that knows what words mean: money, launches, or anything else */
const meaning = (t: string) => /pric|cost|dollar|money|cheap|expensive/i.test(t.replace(/^.*\| (?:query|text): /, '')) ? [1, 0, 0]
  : /launch|live|release|ship/i.test(t.replace(/^.*\| (?:query|text): /, '')) ? [0, 1, 0] : [0, 0, 1]

async function rig(o: { embeds?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-retrieve-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const library = new Library(store.db)
  const embedder = createEmbedder({ engine: { embed: async (_p, texts) => texts.map(meaning), unloadEmbed: async () => {} }, modelPath: () => (o.embeds === false ? undefined : '/m/e.gguf'), id: 'test', dims: 3 })
  const indexer = createIndexer({ store, library, embedder, queue: createQueue({ recording: () => false, smallMac: false }) })
  const add = (title: string, startedAt: number, people: string[], lines: Array<[string | null, string]>, notes?: string) => {
    const m = store.createMeeting({ title, startedAt, endedAt: startedAt + 3_600_000, eventId: null, app: null, attendees: people.map((name) => ({ name, email: null })), state: 'done' })
    store.addSegments(lines.map(([who, text], i) => ({ meetingId: m.id, track: who ? 'them' as const : 'me' as const, startMs: i * 60_000, endMs: i * 60_000 + 50_000, text, speaker: who })))
    if (notes) store.setNotes(m.id, { enhanced: notes })
    return m
  }
  const pricing = add('Pricing call', daysAgo(1), ['Tarun Shah'], [[null, 'Thanks for joining.'], ['Tarun Shah', 'Twenty dollars a seat is what we can do.']], '## Pricing\n- Twenty dollars a seat.\n## Next steps\n- **You:** Send the quote.')
  const launch = add('Weekly sync', daysAgo(9), ['Bo Park'], [[null, 'Where are we?'], ['Bo Park', 'The site goes live on Tuesday.']], '## Launch\n- Live on Tuesday.\n## Next steps\n- **Bo Park:** Write the release notes.')
  const hiring = add('Hiring loop', daysAgo(2), ['Ann Lee'], [['Ann Lee', 'The candidate was strong on systems.']])
  await indexer.schedule()
  const r = (q: string, x: { scope?: string[]; context?: string } = {}) => retrieve({ store, library, indexer, embedder }, q, { now, ...x })
  return { store, library, indexer, r, pricing, launch, hiring }
}

describe('finding what was said across meetings', () => {
  it('by words: names, numbers and exact terms find the line, with where it was said', async () => {
    const t = await rig()
    const got = await t.r('Who said twenty dollars?')
    expect(got.kind).toBe('find')
    // at the line that says it, not where its chunk starts
    expect(got.items[0]).toMatchObject({ meetingId: t.pricing.id, title: 'Pricing call', startedAt: daysAgo(1), atMs: 60_000 })
    expect(got.items[0].text).toContain('Tarun Shah: Twenty dollars a seat')
  })
  it('by meaning: a question in other words still finds it', async () => {
    const t = await rig()
    const got = await t.r('How much would it cost us?')
    expect(got.items[0].meetingId).toBe(t.pricing.id)
  })
  it('before the embedding model is in, words alone still work', async () => {
    const t = await rig({ embeds: false })
    expect((await t.r('when does the site go live?')).items[0].meetingId).toBe(t.launch.id)
  })
  it('dates and people narrow the meetings first', async () => {
    const t = await rig()
    expect((await t.r('what did we talk about yesterday?')).items.map((i) => i.meetingId)).toEqual([t.pricing.id])
    expect(new Set((await t.r('what did Ann say?')).items.map((i) => i.meetingId))).toEqual(new Set([t.hiring.id]))
    // nothing on that day: nothing found, rather than something from another day
    expect((await t.r('what happened on Sunday?')).items).toEqual([])
  })
  it('within the meetings given (a folder), never outside them', async () => {
    const t = await rig()
    const got = await t.r('twenty dollars', { scope: [t.launch.id] })
    expect(got.items.every((i) => i.meetingId === t.launch.id)).toBe(true)
  })
  it('a follow-up is searched together with the question before it', async () => {
    const t = await rig()
    expect((await t.r('and the price?', { context: 'what did Tarun say' })).items[0].meetingId).toBe(t.pricing.id)
  })
})

describe('gathering across meetings', () => {
  it('uses each matching meeting\'s notes, newest first, when the question has a date', async () => {
    const t = await rig()
    const got = await t.r('my to-dos this week')
    expect(got.kind).toBe('across')
    // this week: Monday 2 November on; the Weekly sync was last week
    expect(got.items.map((i) => [i.title, i.atMs])).toEqual([['Pricing call', null], ['Hiring loop', 0]])
    expect(got.items[0].text).toContain('Send the quote')
    // a meeting without notes yet gives its transcript instead
    expect(got.items[1].text).toContain('strong on systems')
  })
  it('without a date, the recent meetings', async () => {
    const t = await rig()
    const got = await t.r('what are my next steps?')
    expect(got.items.map((i) => i.title)).toEqual(['Pricing call', 'Hiring loop', 'Weekly sync'])
  })
})

describe('speed', () => {
  it('a library of a thousand meeting hours is searched in under 200 ms', async () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-retrieve-'))
    dirs.push(d)
    const store = openStore(join(d, 'yogurt.db'))
    stores.push(store)
    // seeding commits ~3000 times; a sync per commit takes over a minute on GitHub's Windows runners
    store.db.exec('PRAGMA synchronous = OFF')
    const library = new Library(store.db)
    const dims = 512
    const rand = () => Float32Array.from({ length: dims }, () => Math.random() - 0.5)
    const embedder = createEmbedder({ engine: { embed: async (_p, texts) => texts.map(() => [...rand()]), unloadEmbed: async () => {} }, modelPath: () => '/m/e.gguf', id: 'test', dims })
    const indexer = createIndexer({ store, library, embedder, queue: createQueue({ recording: () => false, smallMac: false }) })
    const words = 'budget launch pricing hiring roadmap design customer contract renewal travel onboarding support'.split(' ')
    for (let m = 0; m < 1000; m++) {
      const meeting = store.createMeeting({ title: `Meeting ${m}`, startedAt: now - m * 3_600_000, endedAt: null, eventId: null, app: null, attendees: [{ name: `Person ${m % 40}`, email: null }], state: 'done' })
      const chunks = Array.from({ length: 30 }, (_, i) => ({ startMs: i * 120_000, endMs: i * 120_000 + 100_000, text: `You: ${words[(m + i) % words.length]} line ${i}`, speakers: ['You'] }))
      store.db.prepare('INSERT INTO segments (meeting_id, track, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)').run(meeting.id, 'me', 0, 900, `the ${words[m % words.length]} plan for meeting ${m}`)
      library.setChunks(meeting.id, 'x', [`Person ${m % 40}`], chunks)
    }
    const model = embedder.model()
    store.db.exec('BEGIN')
    for (const c of library.unembedded(model, 100_000)) library.setVector(c.id, model, toVector(rand(), dims))
    store.db.exec('COMMIT')
    const ask = () => retrieve({ store, library, indexer, embedder }, 'what did we say about the pricing plan?', { now })
    await ask()
    // the best of three: other test files share the CPU
    let best = Infinity, got = await ask()
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); got = await ask(); best = Math.min(best, performance.now() - t0) }
    // GitHub's Windows runners are about twice as slow as a Mac or Linux runner at this, and noisier
    expect(best).toBeLessThan(process.platform === 'win32' ? 400 : 200)
    expect(got.items).toHaveLength(12)
  }, 60_000)
})

