import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { createEmbedder } from '../src/main/library/embedder'
import { createIndexer } from '../src/main/library/indexer'
import { hookConversations } from '../src/main/library/conversations'
import { libraryHead } from '../src/main/library/prompt'
import { createQueue } from '../src/main/notes/queue'
import { FakeEngine } from '../src/main/notes/fake'
import type { Llm } from '../src/main/notes/enhance'
import type { ConversationView } from '../src/shared/types'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const now = new Date(2026, 10, 4, 15, 30).getTime()

async function rig(o: { llm?: Partial<Llm>; queue?: ReturnType<typeof createQueue>; waitsForModel?: () => boolean; warmAllowed?: () => boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-conversations-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const library = new Library(store.db)
  const engine = new FakeEngine()
  const embedder = createEmbedder({ engine, modelPath: () => '/m/e.gguf', id: 'fake', dims: 768 })
  const queue = o.queue ?? createQueue({ recording: () => false, smallMac: false })
  const indexer = createIndexer({ store, library, embedder, queue })
  const m = store.createMeeting({ title: 'Pricing call', startedAt: now - 86_400_000, endedAt: now, eventId: null, app: null, attendees: [{ name: 'Tarun Shah', email: null }], state: 'done' })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 724_000, endMs: 730_000, text: 'Twenty dollars a seat is our price.', speaker: 'Tarun Shah' }])
  await indexer.schedule()
  const prompts: string[] = []
  const read: string[] = []
  const llm: Llm = {
    readAhead: async (text) => { read.push(text) },
    contextSize: 32_768, count: async (t) => t.map((x) => Math.ceil(x.length / 4)),
    chat: async (prompt, onToken) => { prompts.push(prompt); for (const w of ['It is ', '**twenty dollars** ', 'a seat [1].']) onToken(w); return 'It is **twenty dollars** a seat [1].' },
    ...o.llm,
  }
  const views: ConversationView[] = []
  const lists: unknown[] = []
  const deps = { store, library, indexer, embedder, queue, model: { llm: async () => llm }, send: (v: ConversationView) => { views.push(v) }, sendList: (l: unknown) => { lists.push(l) }, waitsForMeeting: () => false, waitsForModel: o.waitsForModel ?? (() => false), warmAllowed: o.warmAllowed, now: () => now }
  const chats = hookConversations(deps)
  return { store, library, chats, prompts, read, views, lists, meeting: m, deps, file: join(d, 'yogurt.db') }
}

describe('conversations across meetings', () => {
  it('a first question starts a conversation named after it; the answer streams in with its sources and is saved', async () => {
    const t = await rig()
    const { id, done } = t.chats.ask(null, '  What did Tarun say about the price?  ')
    expect(t.chats.list().map((c) => c.title)).toEqual(['What did Tarun say about the price?'])
    await done
    const v = t.chats.view(id)!
    expect(v.turns).toEqual([expect.objectContaining({ question: 'What did Tarun say about the price?', answer: 'It is **twenty dollars** a seat [1].', status: 'done' })])
    expect(v.turns[0].sources).toEqual([{ n: 1, meetingId: t.meeting.id, title: 'Pricing call', startedAt: t.meeting.startedAt, atMs: 724_000, excerpt: expect.stringContaining('Twenty dollars a seat is our price.'),
      transcript: { speakers: ['Tarun Shah'], lines: [{ text: 'Twenty dollars a seat is our price.', track: 'them', speaker: 'Tarun Shah', startMs: 724_000 }] } }])
    expect(t.views.some((x) => x.turns[0]?.status === 'answering' && x.turns[0].sources[0]?.excerpt?.includes('Twenty dollars a seat'))).toBe(true)
    expect(t.prompts[0].startsWith(libraryHead)).toBe(true)
    expect(t.prompts[0]).toContain('Tarun Shah: Twenty dollars a seat')
    // saved: only the sources it cites
    expect(t.library.turns(id)[0]).toMatchObject({ answer: 'It is **twenty dollars** a seat [1].', sources: [{ n: 1, excerpt: expect.stringContaining('Twenty dollars a seat is our price.') }] })
    expect(t.library.turns(id)[0].sources[0].transcript).toEqual(v.turns[0].sources[0].transcript)
    expect(t.views.find(x => x.turns[0]?.status === 'answering' && x.turns[0].sources.length)?.turns[0].sources[0].transcript).toEqual(v.turns[0].sources[0].transcript)
  })

  it('numbers the sources meeting by meeting, and saves an answer citing one meeting several times with one citation', async () => {
    const t = await rig({ llm: { chat: async (prompt) => { t.prompts.push(prompt); return 'Twenty dollars a seat [1][2] [3].' } } })
    const other = t.store.createMeeting({ title: 'Seat count', startedAt: now - 3_600_000, endedAt: now, eventId: null, app: null, attendees: [], state: 'done' })
    // long enough lines that each is its own chunk
    const long = (s: string) => `${s} ${'and so on '.repeat(160)}`
    t.store.addSegments([
      { meetingId: other.id, track: 'them', startMs: 1000, endMs: 2000, text: long('Twenty dollars a seat for fifty seats.'), speaker: 'Ann Lee' },
      { meetingId: other.id, track: 'them', startMs: 9000, endMs: 10_000, text: long('Again twenty dollars a seat.'), speaker: 'Ann Lee' },
    ])
    const { id, done } = t.chats.ask(null, 'Who said twenty dollars a seat?')
    await done
    const turn = t.chats.view(id)!.turns[0]
    const order = turn.sources.map((s) => s.meetingId)
    // each meeting's parts sit together
    expect(order.filter((m, i) => i === 0 || m !== order[i - 1])).toHaveLength(new Set(order).size)
    expect(t.prompts[0].match(/^Meeting: /gm)).toHaveLength(2)
    expect(new Set(turn.sources.map((s) => s.meetingId)).size).toBe(2)
    // [1][2] [3] cite at most two meetings: one citation each
    const cited = turn.answer.match(/\[([\d, ]+)\]/)![1].split(', ').map(Number)
    expect(new Set(cited.map((n) => turn.sources[n - 1].meetingId)).size).toBe(cited.length)
  })

  it('a follow-up in the same conversation sees the turns before it', async () => {
    const t = await rig()
    const first = t.chats.ask(null, 'What did Tarun say about the price?')
    await first.done
    await t.chats.ask(first.id, 'Is that per month?').done
    expect(t.prompts[1]).toContain('<asked>\nWhat did Tarun say about the price?\n</asked>')
    expect(t.chats.view(first.id)!.turns).toHaveLength(2)
    expect(t.chats.list()).toHaveLength(1)
  })

  it('rename and delete; the list is newest first', async () => {
    const t = await rig()
    const a = t.chats.ask(null, 'First?'); await a.done
    const b = t.chats.ask(null, 'Second?'); await b.done
    expect(t.chats.list().map((c) => c.title)).toEqual(['Second?', 'First?'])
    t.chats.rename(a.id, '  Pricing  ')
    expect(t.chats.view(a.id)!.title).toBe('Pricing')
    t.chats.remove(b.id)
    expect(t.chats.list().map((c) => c.id)).toEqual([a.id])
    expect(t.chats.view(b.id)).toBeUndefined()
  })

  it('stop keeps what was written so far', async () => {
    let release = () => {}
    const t = await rig({ llm: { chat: async (_p, onToken) => { onToken('Half '); await new Promise<void>((r) => { release = r }); return 'Half and more' } } })
    const { id, done } = t.chats.ask(null, 'Q?')
    await new Promise((r) => setTimeout(r, 20))
    t.chats.stop(id)
    release()
    await done
    expect(t.chats.view(id)!.turns[0]).toMatchObject({ answer: 'Half', status: 'stopped' })
  })

  it('a long title is cut at a word', async () => {
    const t = await rig()
    const { id, done } = t.chats.ask(null, 'What did everyone say about the new pricing plan for teams and the yearly discount we talked about?')
    await done
    expect(t.chats.view(id)!.title).toBe('What did everyone say about the new pricing plan for…')
  })

  it('says when answers wait for the notes model (first run)', async () => {
    let have = false
    const t = await rig({ waitsForModel: () => !have })
    const { id, done } = t.chats.ask(null, 'Q?')
    expect(t.chats.view(id)!.waitsForModel).toBe(true)
    have = true
    expect(t.chats.view(id)!.waitsForModel).toBe(false)
    await done
  })

  it('an answer that fails says so, and asking again replaces it', async () => {
    let fail = true
    const t = await rig({ llm: { chat: async (_p, onToken) => { if (fail) throw new Error('boom'); onToken('Fine.'); return 'Fine.' } } })
    const a = t.chats.ask(null, 'Q?')
    await a.done
    expect(t.chats.view(a.id)!.turns.map((x) => x.status)).toEqual(['failed'])
    fail = false
    await t.chats.ask(a.id, 'Q?').done
    expect(t.chats.view(a.id)!.turns.map((x) => [x.status, x.answer])).toEqual([['done', 'Fine.']])
  })

  it('a recording that needs the room stops the answer midway: what was written goes, it waits, then answers in full', async () => {
    let recording = false
    const queue = createQueue({ recording: () => recording, smallMac: true })
    let calls = 0
    let release = () => {}
    const t = await rig({ queue, llm: { chat: async (_p, onToken, opts) => {
      calls++
      if (calls === 1) { onToken('Half '); await new Promise<void>((r) => { release = r }); return 'Half' }
      onToken('Whole answer [1].'); return 'Whole answer [1].'
    } } })
    const { id, done } = t.chats.ask(null, 'Q?')
    await new Promise((r) => setTimeout(r, 20))
    expect(t.chats.view(id)!.turns[0].answer).toBe('Half ')
    recording = true
    queue.recordingChanged()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(t.chats.view(id)!.turns[0]).toMatchObject({ status: 'waiting', answer: '' })
    recording = false
    queue.recordingChanged()
    await done
    expect(t.chats.view(id)!.turns[0]).toMatchObject({ status: 'done', answer: 'Whole answer [1].' })
  })
})

it('the shared store uses the full live transcript for one meeting, then keeps the answer and initial chip', async () => {
  const t = await rig({ llm: { chat: async (prompt, onToken) => { t.prompts.push(prompt); onToken('Twenty dollars.'); return 'Twenty dollars.' } } })
  t.store.updateMeeting(t.meeting.id, { state: 'recording', endedAt: null })
  const chips = [{ kind: 'meeting' as const, id: t.meeting.id }]
  const id = t.library.current(chips)
  expect(t.chats.view(id)).toMatchObject({ chips, draftChips: chips, firstChips: null })
  t.library.setDraft(id, 'What is the price?')
  await t.chats.ask(id, 'What is the price?').done
  expect(t.prompts[0]).toContain('Tarun Shah: Twenty dollars a seat')
  expect(t.prompts[0].startsWith(libraryHead)).toBe(false)
  expect(t.chats.view(id)).toMatchObject({ draft: '', chips, firstChips: chips, turns: [{ answer: 'Twenty dollars.', status: 'done' }] })
  expect(t.store.chatTurns(t.meeting.id)).toEqual([])
  t.chats.context(id, [])
  expect(t.chats.view(id)).toMatchObject({ chips, firstChips: chips, draftChips: [] })
  t.chats.removeContext(id, chips[0])
  expect(t.chats.view(id)).toMatchObject({ chips: [], firstChips: chips, turns: [{ answer: 'Twenty dollars.' }] })
})

it('an empty chip scope never reads unrelated meetings, while folder and meeting chips are unioned', async () => {
  const t = await rig()
  const folder = t.store.createFolder('Project')
  const id = t.library.current([{ kind: 'folder', id: folder.id }])
  await t.chats.ask(id, 'What was decided?').done
  expect(t.prompts[0]).not.toContain('Twenty dollars a seat')
  t.store.addToFolder(folder.id, t.meeting.id)
  const prepared = t.store.createMeeting({ title: 'Prep', startedAt: now, endedAt: null, state: 'prepared', eventId: null, app: null, attendees: [] })
  t.store.setNotes(prepared.id, { mine: 'Ask about the October budget.' })
  t.chats.context(id, [{ kind: 'folder', id: folder.id }, { kind: 'meeting', id: prepared.id }])
  expect(t.chats.view(id)).toMatchObject({ chips: [{ kind: 'folder', id: folder.id }], draftChips: [{ kind: 'meeting', id: prepared.id }] })
  await t.chats.ask(id, 'What are my next steps?').done
  expect(t.chats.view(id)).toMatchObject({ chips: [{ kind: 'folder', id: folder.id }, { kind: 'meeting', id: prepared.id }], draftChips: [] })
  expect(t.prompts.at(-1)).toContain('Twenty dollars a seat')
  expect(t.prompts.at(-1)).toContain('October budget')
})

it('does not acknowledge and discard a draft when its conversation is deleted or already answering', async () => {
  let recording = false
  const queue = createQueue({ recording: () => recording, smallMac: true })
  const t = await rig({ queue })
  recording = true
  const id = t.library.current([])
  const first = t.chats.ask(id, 'First question')
  t.library.setDraft(id, 'Keep my second question')
  expect(() => t.chats.ask(id, 'Keep my second question')).toThrow('already running')
  expect(() => t.chats.removeContext(id, { kind: 'meeting', id: t.meeting.id })).toThrow('current answer')
  expect(t.library.conversation(id)?.draft).toBe('Keep my second question')
  t.chats.stop(id); await first.done
  t.chats.removeContext(id, { kind: 'meeting', id: t.meeting.id })
  expect(t.chats.view(id)?.chips).toEqual([])
  t.chats.remove(id)
  expect(() => t.chats.ask(id, 'Keep this too')).toThrow('not found')
})

describe('the step an answer is on, shown until its first words', () => {
  it('across meetings: searching, then reading the meetings found (one by its title)', async () => {
    const t = await rig()
    const { id, done } = t.chats.ask(null, 'What did Tarun say about the price?')
    await done
    const steps = t.views.filter((v) => v.id === id).map((v) => v.turns[0]?.step).filter(Boolean)
    expect(steps[0]).toEqual({ kind: 'searching' })
    expect(steps).toContainEqual({ kind: 'reading', meetings: 1, title: 'Pricing call' })
  })
  it('one meeting: reading it by its title', async () => {
    // reading takes a moment, so the step reaches the window before the first words
    const t = await rig({ llm: { chat: async (prompt, onToken) => { t.prompts.push(prompt); await new Promise((r) => setTimeout(r, 80)); onToken('Twenty.'); return 'Twenty.' } } })
    const id = t.library.current([{ kind: 'meeting', id: t.meeting.id }])
    await t.chats.ask(id, 'What is the price?').done
    expect(t.views.map((v) => v.turns[0]?.step)).toContainEqual({ kind: 'reading', title: 'Pricing call' })
  })
})

describe('warm: one meeting read in when its conversation opens', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20))
  it('reads the meeting in for a conversation about exactly one meeting, once for repeated opens', async () => {
    const t = await rig()
    const id = t.library.current([{ kind: 'meeting', id: t.meeting.id }])
    t.chats.warm(id); t.chats.warm(id)
    await settle()
    t.chats.warm(id)
    await settle()
    expect(t.read).toHaveLength(1)
    expect(t.read[0]).toContain('Twenty dollars a seat is our price.')
    await t.chats.ask(id, 'What is the price?').done
    expect(t.prompts[0].startsWith(t.read[0])).toBe(true)
  })
  it('nothing for a global conversation, a folder, or when it is not allowed (the model is missing, a small Mac records)', async () => {
    const t = await rig()
    t.chats.warm(t.library.current([]))
    t.chats.warm(t.library.current([{ kind: 'folder', id: t.store.createFolder('Project').id }]))
    await settle()
    expect(t.read).toEqual([])
    const off = await rig({ warmAllowed: () => false })
    off.chats.warm(off.library.current([{ kind: 'meeting', id: off.meeting.id }]))
    const waiting = await rig({ waitsForModel: () => true })
    waiting.chats.warm(waiting.library.current([{ kind: 'meeting', id: waiting.meeting.id }]))
    await settle()
    expect([...off.read, ...waiting.read]).toEqual([])
  })
})


describe('questions waiting for the first notes download', () => {
  it.each(['meeting', 'library'])('answers a waiting %s question when the model arrives', async scope => {
    let ready = true
    const queue = createQueue({ smallMac: false, recording: () => false, modelReady: () => ready })
    const t = await rig({ queue, waitsForModel: () => !ready })
    ready = false
    const cid = scope === 'meeting' ? t.library.current([{ kind: 'meeting', id: t.meeting.id }]) : null
    const { id, done } = t.chats.ask(cid, 'What is the price?')
    expect(t.chats.view(id)?.turns[0].status).toBe('waiting')
    expect(t.library.turns(id)[0].waitingModel).toBe(true)
    expect(t.prompts).toEqual([])
    ready = true; queue.modelArrived()
    await done
    expect(t.chats.view(id)?.turns[0].status).toBe('done')
    expect(t.library.waitingTurns()).toEqual([])
    expect(t.prompts).toHaveLength(1)
  })

  it.each([
    ['meeting', false], ['library', false], ['meeting', true], ['library', true],
  ] as const)('resumes the same saved %s question after reopening the database (model already ready: %s)', async (scope, readyOnRestart) => {
    let ready = true
    const queue = createQueue({ smallMac: false, recording: () => false, modelReady: () => ready })
    const t = await rig({ queue, waitsForModel: () => !ready })
    ready = false
    const cid = scope === 'meeting' ? t.library.current([{ kind: 'meeting', id: t.meeting.id }]) : null
    const { id } = t.chats.ask(cid, 'What is the price?')
    const saved = t.library.turns(id)[0]
    t.store.close(); stores.splice(stores.indexOf(t.store), 1)
    const store = openStore(t.file); stores.push(store)
    const library = new Library(store.db)
    ready = readyOnRestart
    const resumedQueue = createQueue({ smallMac: false, recording: () => false, modelReady: () => ready })
    const engine = new FakeEngine()
    const embedder = createEmbedder({ engine, modelPath: () => '/m/e.gguf', id: 'fake', dims: 768 })
    const indexer = createIndexer({ store, library, embedder, queue: resumedQueue })
    const resumed = hookConversations({ ...t.deps, store, library, embedder, indexer, queue: resumedQueue })
    if (!ready) expect(resumed.view(id)?.turns[0].status).toBe('waiting')
    ready = true; resumedQueue.modelArrived()
    await expect.poll(() => resumed.view(id)?.turns[0].status).toBe('done')
    expect(library.turns(id)).toHaveLength(1)
    expect(library.turns(id)[0]).toMatchObject({ id: saved.id, question: saved.question, waitingModel: false })
    expect(t.prompts).toHaveLength(1)
    if (scope === 'meeting') expect(resumed.view(id)?.chips).toMatchObject([{ kind: 'meeting', id: t.meeting.id }])
  })

  it('queues imported waiting questions on refresh, without duplicating running work', async () => {
    let ready = true
    const queue = createQueue({ smallMac: false, recording: () => false, modelReady: () => ready })
    const t = await rig({ queue, waitsForModel: () => !ready })
    ready = false
    const id = t.library.current([], true)
    const turn = t.library.addTurn(id, 'Imported waiting question', now, true)
    t.chats.refresh(); t.chats.refresh()
    expect(t.chats.view(id)?.turns).toMatchObject([{ id: turn, status: 'waiting' }])
    ready = true; queue.modelArrived()
    await expect.poll(() => t.chats.view(id)?.turns[0].status).toBe('done')
    expect(t.library.turns(id)).toHaveLength(1)
    expect(t.prompts).toHaveLength(1)
  })

  it('keeps cancelled questions stopped and never resumes an interrupted answer', async () => {
    let ready = true
    const queue = createQueue({ smallMac: false, recording: () => false, modelReady: () => ready })
    const t = await rig({ queue, waitsForModel: () => !ready })
    ready = false
    const { id, done } = t.chats.ask(null, 'Cancel this question')
    t.chats.stop(id); await done
    expect(t.library.waitingTurns()).toEqual([])
    const other = t.library.current([], true)
    t.library.addTurn(other, 'Interrupted during inference')
    const resumed = hookConversations(t.deps)
    expect(resumed.view(id)?.turns[0].status).toBe('stopped')
    expect(resumed.view(other)?.turns[0].status).toBe('stopped')
    ready = true; queue.modelArrived()
    expect(t.prompts).toEqual([])
  })
})
