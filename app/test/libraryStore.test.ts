import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library, libraryTables } from '../src/main/library/store'

const dirs: string[] = []
const stores: Store[] = []
function fresh() {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-library-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return { s, lib: new Library(s.db) }
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const meeting = (s: Store, title: string, state: 'done' | 'recording' = 'done') =>
  s.createMeeting({ title, startedAt: 1000, endedAt: 2000, eventId: null, app: null, attendees: [{ name: 'Tarun Shah', email: null }], state })
const chunk = (startMs: number, text: string) => ({ startMs, endMs: startMs + 5000, text, speakers: ['You'] })

describe('the library index', () => {
  it('knows which finished meetings need chunks: new ones, and ones whose lines, title or people changed since', () => {
    const { s, lib } = fresh()
    const a = meeting(s, 'Pricing')
    meeting(s, 'Live', 'recording')
    s.addSegments([{ meetingId: a.id, track: 'me', startMs: 0, endMs: 900, text: 'The price is 20 dollars', speaker: null }])
    const [stale] = lib.stale()
    expect(lib.stale().map((x) => x.meetingId)).toEqual([a.id])
    lib.setChunks(a.id, stale.signature, ['You', 'Tarun Shah'], [chunk(0, 'You: The price is 20 dollars')])
    expect(lib.stale()).toEqual([])
    s.addSegments([{ meetingId: a.id, track: 'them', startMs: 1000, endMs: 1900, text: 'Too much', speaker: 'Tarun Shah' }])
    expect(lib.stale().map((x) => x.meetingId)).toEqual([a.id])
    lib.setChunks(a.id, lib.stale()[0].signature, [], [])
    s.updateMeeting(a.id, { title: 'Pricing call' })
    expect(lib.stale().map((x) => x.meetingId)).toEqual([a.id])
  })

  it('keeps vectors per chunk and per model; new chunks for a meeting drop its old ones', () => {
    const { s, lib } = fresh()
    const a = meeting(s, 'Pricing')
    lib.setChunks(a.id, 'sig', [], [chunk(0, 'one'), chunk(5000, 'two')])
    const todo = lib.unembedded('gemma@512', 10)
    expect(todo.map((c) => c.text)).toEqual(['one', 'two'])
    expect(todo[0]).toMatchObject({ meetingId: a.id, title: 'Pricing' })
    lib.setVector(todo[0].id, 'gemma@512', new Float32Array([0.6, 0.8]))
    expect(lib.unembedded('gemma@512', 10).map((c) => c.text)).toEqual(['two'])
    // another model's vectors don't count
    expect(lib.unembedded('other@256', 10)).toHaveLength(2)
    expect(lib.vectors('gemma@512')).toEqual([{ id: todo[0].id, meetingId: a.id, vector: new Float32Array([0.6, 0.8]) }])
    lib.setChunks(a.id, 'sig2', [], [chunk(0, 'three')])
    expect(lib.vectors('gemma@512')).toEqual([])
    expect(lib.chunks(lib.unembedded('gemma@512', 10).map((c) => c.id)).map((c) => c.text)).toEqual(['three'])
  })

  it('finds chunks by the words in their lines, best match first, within the meetings asked for', () => {
    const { s, lib } = fresh()
    const a = meeting(s, 'Pricing'), b = meeting(s, 'Hiring')
    s.addSegments([
      { meetingId: a.id, track: 'me', startMs: 0, endMs: 900, text: 'Hello everyone', speaker: null },
      { meetingId: a.id, track: 'them', startMs: 6000, endMs: 6900, text: 'The pricing for fifty seats is fine', speaker: 'Tarun Shah' },
      { meetingId: b.id, track: 'me', startMs: 0, endMs: 900, text: 'We need pricing for the contractor', speaker: null },
    ])
    lib.setChunks(a.id, 'x', [], [chunk(0, 'You: Hello everyone'), chunk(5000, 'Tarun Shah: The pricing for fifty seats is fine')])
    lib.setChunks(b.id, 'y', [], [chunk(0, 'You: We need pricing for the contractor')])
    const hits = lib.wordHits(['pricing', 'seats'])
    expect(lib.chunks(hits).map((c) => c.text)).toEqual(['Tarun Shah: The pricing for fifty seats is fine', 'You: We need pricing for the contractor'])
    expect(lib.chunks(lib.wordHits(['pricing'], [b.id])).map((c) => c.meetingId)).toEqual([b.id])
    expect(lib.wordHits([])).toEqual([])
    // where in its chunk the best line is
    const at = new Map<number, number>()
    lib.wordHits(['seats'], undefined, 300, at)
    expect([...at.values()]).toEqual([6000])
  })

  it('a deleted meeting takes its chunks with it', () => {
    const { s, lib } = fresh()
    const a = meeting(s, 'Pricing')
    lib.setChunks(a.id, 'x', ['Tarun Shah'], [chunk(0, 'one')])
    s.deleteMeeting(a.id)
    expect(lib.unembedded('m', 10)).toEqual([])
    expect(lib.people()).toEqual([])
  })
})

describe('conversations', () => {
  it('are kept newest first, with their turns and sources; renamed and deleted', () => {
    const { lib } = fresh()
    const a = lib.createConversation('First', 1000)
    const b = lib.createConversation('Second', 2000)
    expect(lib.conversations().map((c) => c.title)).toEqual(['Second', 'First'])
    const t = lib.addTurn(a, 'what about pricing?', 3000)
    lib.setTurn(t, 'It is 20 dollars [1].', false, [{ n: 1, meetingId: 'm1', title: 'Pricing', startedAt: 5, atMs: 6000 }])
    // asking moves a conversation to the top
    expect(lib.conversations().map((c) => c.id)).toEqual([a, b])
    expect(lib.turns(a)).toEqual([{ id: t, question: 'what about pricing?', answer: 'It is 20 dollars [1].', stopped: false, waitingModel: false, sources: [{ n: 1, meetingId: 'm1', title: 'Pricing', startedAt: 5, atMs: 6000 }] }])
    lib.renameConversation(a, 'Pricing questions')
    expect(lib.conversation(a)?.title).toBe('Pricing questions')
    lib.deleteConversation(a)
    expect(lib.conversation(a)).toBeUndefined()
    expect(lib.turns(a)).toEqual([])
  })
})


it('adds download-wait persistence to an existing database without reclassifying old turns', () => {
  const { s, lib } = fresh()
  const id = lib.createConversation('Existing conversation')
  const answered = lib.addTurn(id, 'Answered question')
  lib.setTurn(answered, 'Saved answer', false, [])
  const interrupted = lib.addTurn(id, 'Interrupted question')
  s.db.exec('ALTER TABLE conversation_turns DROP COLUMN waiting_model')
  libraryTables(s.db)
  expect(lib.turns(id)).toMatchObject([
    { id: answered, answer: 'Saved answer', waitingModel: false },
    { id: interrupted, answer: '', waitingModel: false },
  ])
  expect(lib.waitingTurns()).toEqual([])
  const waiting = lib.addTurn(id, 'Waiting for the download', 3000, true)
  libraryTables(s.db)
  expect(lib.waitingTurns()).toEqual([{ conversationId: id, id: waiting, question: 'Waiting for the download' }])
})
