import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore, type Store } from '../src/main/store'
import { Library, migrateMeetingChats } from '../src/main/library/store'
import { mergeBackup } from '../src/main/backup'
import { askDestination, attachContext, chipScope, contextKey, mentionAt } from '../src/shared/askContext'

const dirs: string[] = [], stores: Store[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-context-')); dirs.push(dir)
  const file = join(dir, 'yogurt.db'), store = openStore(file); stores.push(store)
  return { store, file, library: new Library(store.db) }
}
const meeting = (s: Store, title: string) => s.createMeeting({ title, startedAt: 1000, endedAt: 2000, state: 'done', eventId: null, app: null, attendees: [] })
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })

it('migrates every meeting turn once, retaining global chats, interrupted questions and legacy rows across reload', () => {
  const { store: s, library: l, file } = fresh()
  const m = meeting(s, 'Planning'), global = l.createConversation('Global history', 10)
  l.setTurn(l.addTurn(global, 'Across all meetings?', 12), 'Global answer', false, [])
  const a = s.addChatTurn(m.id, 'First?'); s.setChatAnswer(a, 'First answer')
  const b = s.addChatTurn(m.id, 'Stopped?'); s.setChatAnswer(b, 'Partial', true)
  s.addChatTurn(m.id, 'Interrupted?')
  // Columns absent in the installed version; exercise the actual schema upgrade on open.
  for (const col of ['chips', 'draft', 'draft_chips', 'current_key', 'legacy_meeting_id', 'first_chips']) s.db.exec(`ALTER TABLE conversations DROP COLUMN ${col}`)
  s.db.exec('ALTER TABLE chat_turns DROP COLUMN unified')
  s.close(); stores.splice(stores.indexOf(s), 1)
  const reopened = openStore(file); stores.push(reopened)
  const lib = new Library(reopened.db), chips = [{ kind: 'meeting' as const, id: m.id }]
  const id = lib.current(chips)
  expect(lib.conversations()).toHaveLength(2)
  expect(lib.current([])).toBe(global)
  expect(lib.conversation(id)).toMatchObject({ chips, firstChips: chips })
  expect(lib.turns(id).map(t => [t.question, t.answer, t.stopped])).toEqual([
    ['First?', 'First answer', false], ['Stopped?', 'Partial', true], ['Interrupted?', '', false],
  ])
  expect(reopened.chatTurns(m.id)).toHaveLength(3)
  migrateMeetingChats(reopened.db)
  expect(lib.turns(id)).toHaveLength(3)
  lib.deleteConversation(id); migrateMeetingChats(reopened.db)
  expect(lib.conversations().map(c => c.id)).toEqual([global])
})

it('rolls a failed migration back without marking or losing a legacy turn', () => {
  const { store: s, library: l } = fresh(), m = meeting(s, 'Planning')
  s.addChatTurn(m.id, 'Keep me')
  s.db.exec("CREATE TRIGGER fail_copy BEFORE INSERT ON conversation_turns BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  expect(() => migrateMeetingChats(s.db)).toThrow('disk failure')
  expect(l.conversations()).toEqual([])
  expect(s.db.prepare('SELECT unified FROM chat_turns').get()?.unified).toBe(0)
  s.db.exec('DROP TRIGGER fail_copy'); migrateMeetingChats(s.db)
  expect(l.turns(l.current([{ kind: 'meeting', id: m.id }]))[0].question).toBe('Keep me')
})

it('retains ordered chips, the initial message context, drafts and current chats when starting fresh or changing context', () => {
  const { library: l, file } = fresh()
  const chips = [{ kind: 'meeting' as const, id: 'm' }, { kind: 'folder' as const, id: 'f' }]
  const a = l.current(chips)
  l.setDraft(a, 'Unsent text')
  const b = l.current(chips, true)
  expect(b).not.toBe(a); expect(l.current([...chips].reverse())).toBe(b)
  expect(l.conversation(a)?.draft).toBe('Unsent text')
  l.addTurn(b, 'Question?'); l.setContext(b, [])
  expect(l.current(chips)).toBe(b)
  expect(l.conversation(b)).toMatchObject({ chips, firstChips: chips, draft: '', draftChips: [] })
  const s = openStore(file); stores.push(s)
  expect(new Library(s.db).conversation(a)?.draft).toBe('Unsent text')
  expect(contextKey(chips)).toBe(contextKey([...chips].reverse()))
})

it('attaches context in order once, without duplicating a meeting or a folder', () => {
  const a = { kind: 'meeting' as const, id: 'a' }, b = { kind: 'folder' as const, id: 'a' }
  expect(attachContext([], [a, a, b])).toEqual([a, b])
  expect(attachContext([a], [b, a, b])).toEqual([a, b])
  expect(attachContext([a, b], [])).toEqual([a, b])
})

it('keeps later attachments as removable drafts until send, then appends them to scope atomically', () => {
  const { store: s, library: l, file } = fresh()
  const a = { kind: 'meeting' as const, id: 'a' }, b = { kind: 'folder' as const, id: 'b' }
  const id = l.current([a])
  l.addTurn(id, 'First?')
  l.setContext(id, [a, b]); l.setDraft(id, 'Next?')
  expect(l.conversation(id)).toMatchObject({ chips: [a], draftChips: [b], firstChips: [a] })
  const reopened = openStore(file); stores.push(reopened)
  expect(new Library(reopened.db).conversation(id)?.draftChips).toEqual([b])
  const pendingBackup = fresh(); mergeBackup(pendingBackup.store.db, s.db)
  expect(pendingBackup.library.conversation(id)).toMatchObject({ chips: [a], draftChips: [b], draft: 'Next?' })
  l.setContext(id, [])
  expect(l.conversation(id)).toMatchObject({ chips: [a], draftChips: [] })
  l.setContext(id, [b])
  s.db.exec("CREATE TRIGGER fail_attach BEFORE INSERT ON conversation_turns BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  expect(() => l.addTurn(id, 'Next?')).toThrow('disk failure')
  expect(l.conversation(id)).toMatchObject({ chips: [a], draftChips: [b], draft: 'Next?' })
  s.db.exec('DROP TRIGGER fail_attach')
  l.addTurn(id, 'Next?')
  expect(l.conversation(id)).toMatchObject({ chips: [a, b], draftChips: [], draft: '', firstChips: [a] })
  expect(l.current([a, b])).toBe(id)
  const target = fresh(); mergeBackup(target.store.db, s.db)
  expect(target.library.conversation(id)).toMatchObject({ chips: [a, b], draftChips: [] })
})

it('applies the attachment limit to sent scope plus pending attachments without discarding the draft', () => {
  const { library: l } = fresh()
  const chips = Array.from({ length: 39 }, (_, i) => ({ kind: 'meeting' as const, id: String(i) }))
  const id = l.current(chips), last = { kind: 'folder' as const, id: 'last' }
  l.addTurn(id, 'First?'); l.setContext(id, [last])
  expect(() => l.setContext(id, [last, { kind: 'meeting', id: 'overflow' }])).toThrow('Too many')
  expect(l.conversation(id)?.draftChips).toEqual([last])
  l.addTurn(id, 'Next?')
  expect(l.conversation(id)?.chips).toHaveLength(40)
  l.setContext(id, [...chips, last])
  expect(l.conversation(id)?.draftChips).toEqual([])
})

it('removes saved or pending context without changing history, and restores global scope when the last item is removed', () => {
  const { store: s, library: l, file } = fresh()
  const a = { kind: 'meeting' as const, id: 'a' }, b = { kind: 'folder' as const, id: 'a' }
  const id = l.current([a])
  l.removeContext(id, a)
  expect(l.conversation(id)).toMatchObject({ chips: [], firstChips: null })
  l.setContext(id, [a]); l.addTurn(id, 'First?')
  l.setContext(id, [b]); l.setDraft(id, 'Keep this draft')
  l.removeContext(id, b)
  expect(l.conversation(id)).toMatchObject({ chips: [a], draftChips: [] })
  l.setContext(id, [b])
  s.db.exec("CREATE TRIGGER fail_remove BEFORE UPDATE OF chips ON conversations BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  expect(() => l.removeContext(id, a)).toThrow('disk failure')
  expect(l.conversation(id)).toMatchObject({ chips: [a], draftChips: [b] })
  s.db.exec('DROP TRIGGER fail_remove')
  l.removeContext(id, a)
  expect(l.conversation(id)).toMatchObject({ chips: [], draftChips: [b], firstChips: [a], draft: 'Keep this draft' })
  expect(l.scope(l.conversation(id)!.chips)).toBeUndefined()
  expect(l.current([])).toBe(id)
  l.addTurn(id, 'Next?')
  expect(l.conversation(id)).toMatchObject({ chips: [b], firstChips: [a], draftChips: [] })
  expect(l.turns(id).map(t => t.question)).toEqual(['First?', 'Next?'])
  const reopened = openStore(file); stores.push(reopened)
  expect(new Library(reopened.db).conversation(id)?.chips).toEqual([b])
})

it('preserves existing conversation scope when adding the draft attachment column', () => {
  const { store: s, library: l, file } = fresh()
  const chips = [{ kind: 'meeting' as const, id: 'a' }], id = l.current(chips)
  l.addTurn(id, 'Already sent'); l.setDraft(id, 'Keep my text')
  s.db.exec('ALTER TABLE conversations DROP COLUMN draft_chips; UPDATE conversations SET first_chips = NULL')
  s.close(); stores.splice(stores.indexOf(s), 1)
  const reopened = openStore(file); stores.push(reopened)
  expect(new Library(reopened.db).conversation(id)).toMatchObject({ chips, firstChips: chips, draftChips: [], draft: 'Keep my text' })
})

it('backs up and imports new conversations, chips and drafts, and converts imported legacy turns', () => {
  const from = fresh(), to = fresh(), m = meeting(from.store, 'Legacy')
  from.store.addChatTurn(m.id, 'Old question')
  const f = from.store.createFolder('Project')
  from.store.addToFolder(f.id, m.id)
  const id = from.library.current([{ kind: 'folder', id: f.id }]); from.library.setDraft(id, 'My draft')
  mergeBackup(to.store.db, from.store.db)
  expect(to.library.conversation(id)).toMatchObject({ draft: 'My draft', chips: [{ kind: 'folder', id: f.id }] })
  expect(to.library.turns(to.library.current([{ kind: 'meeting', id: m.id }]))[0].question).toBe('Old question')
  mergeBackup(to.store.db, from.store.db)
  expect(to.library.conversations()).toHaveLength(2)
})

it('unions live folder membership without duplicates or widening an empty/deleted selection to global', () => {
  const { store: s, library: l } = fresh(), a = meeting(s, 'A'), b = meeting(s, 'B'), f = s.createFolder('Project')
  s.addToFolder(f.id, a.id); s.addToFolder(f.id, b.id)
  const chips = [{ kind: 'meeting' as const, id: a.id }, { kind: 'folder' as const, id: f.id }]
  expect(l.scope(chips)).toEqual([a.id, b.id])
  s.removeFromFolder(f.id, b.id); expect(l.scope(chips)).toEqual([a.id])
  s.deleteFolder(f.id)
  expect(l.scope([{ kind: 'folder', id: f.id }])).toEqual([])
  expect(l.scope([{ kind: 'meeting', id: 'gone' }])).toEqual([])
  expect(chipScope([], () => true, () => [])).toBeUndefined()
})

it('routes Command-J to the current note/folder/global conversation, and a fresh global one from Ask', () => {
  expect(askDestination('/note/n')).toEqual({ panel: true, fresh: false, chips: [{ kind: 'meeting', id: 'n' }] })
  expect(askDestination('/folder/f')).toEqual({ panel: false, fresh: false, chips: [{ kind: 'folder', id: 'f' }] })
  for (const route of ['', '/trash', '/settings']) expect(askDestination(route)).toEqual({ panel: false, fresh: false, chips: [] })
  for (const route of ['/chat', '/chat/c']) expect(askDestination(route)).toEqual({ panel: false, fresh: true, chips: [] })
})

it('finds a mention at the caret without treating emails as chips or consuming text after the caret', () => {
  expect(mentionAt('Ask @Planning next', 13)).toEqual({ start: 4, end: 13, query: 'Planning' })
  expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  expect(mentionAt('dana@example.com', 16)).toBeUndefined()
  expect(mentionAt('@Planning\nnext', 14)).toBeUndefined()
})

it('a failed question insert leaves the draft and first-message context intact', () => {
  const { store: s, library: l } = fresh(), id = l.current([])
  l.setDraft(id, 'Keep this draft')
  s.db.exec("CREATE TRIGGER fail_question BEFORE INSERT ON conversation_turns BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  expect(() => l.addTurn(id, 'Keep this draft')).toThrow('disk failure')
  expect(l.conversation(id)).toMatchObject({ draft: 'Keep this draft', firstChips: null })
})

it('resolves current meeting and folder titles, preserving user titles and identifying unnamed meetings', () => {
  const { store: s, library: l } = fresh(), m = meeting(s, 'Meeting')
  const folder = s.db.prepare('INSERT INTO folders (id,name,created_at) VALUES (?,?,?)')
  folder.run('f', 'Customers', 1)
  const chips = [{ kind: 'meeting' as const, id: m.id }, { kind: 'folder' as const, id: 'f' }]
  expect(l.describe(chips).map(c => c.title)).toEqual(['', 'Customers'])
  s.updateMeeting(m.id, { title: 'Design review with LT', titleSource: 'user' })
  s.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run('Product', 'f')
  expect(l.describe(chips).map(c => c.title)).toEqual(['Design review with LT', 'Product'])
  s.updateMeeting(m.id, { title: 'Meeting', titleSource: 'user' })
  expect(l.describe(chips)[0].title).toBe('Meeting')
  expect(l.describe([{ kind: 'meeting', id: 'missing' }])[0].title).toBe('')
})
