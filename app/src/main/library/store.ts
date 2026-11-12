import { attachContext, chipScope, contextKey, type ContextChip, type ContextTarget } from '../../shared/askContext'
import { resolvePeople } from '../people'
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import type { Chunk } from './chunks'
import type { LibrarySource } from '../../shared/types'

type Row = Record<string, unknown>

/**
 * The tables for chat across meetings, made with the rest in the Store constructor:
 * - library_sources: which version of each meeting its chunks were made from, and who was in it (for questions about a speaker);
 * - library_chunks: the chunks, and each one's vector once the embedding model has read it (vector_model says which);
 * - conversations, conversation_turns: the saved chats. Not tied to a meeting, so backup.ts carries them on their own.
 */
export function libraryTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_sources (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, signature TEXT NOT NULL, people TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS library_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, speakers TEXT NOT NULL DEFAULT '[]', vector BLOB, vector_model TEXT);
    CREATE INDEX IF NOT EXISTS library_chunks_meeting ON library_chunks(meeting_id, start_ms);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', stopped INTEGER NOT NULL DEFAULT 0, sources TEXT NOT NULL DEFAULT '[]', asked_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_turns_conversation ON conversation_turns(conversation_id, id);
  `)
  if (!(db.prepare('PRAGMA table_info(conversation_turns)').all() as Row[]).some(r => r.name === 'waiting_model')) db.exec('ALTER TABLE conversation_turns ADD COLUMN waiting_model INTEGER NOT NULL DEFAULT 0')
  const cols = (db.prepare('PRAGMA table_info(conversations)').all() as Row[]).map(r => r.name)
  for (const [name, definition] of Object.entries({ chips: "TEXT NOT NULL DEFAULT '[]'", draft: "TEXT NOT NULL DEFAULT ''", draft_chips: "TEXT NOT NULL DEFAULT '[]'", current_key: 'TEXT', legacy_meeting_id: 'TEXT', first_chips: 'TEXT' })) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`)
  }
  // Old global chats have no chips; the latest is the current global conversation.
  if (!cols.includes('current_key')) db.exec("UPDATE conversations SET current_key = '[]' WHERE id = (SELECT id FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT 1)")
  if (!(db.prepare('PRAGMA table_info(chat_turns)').all() as Row[]).some(r => r.name === 'unified')) db.exec('ALTER TABLE chat_turns ADD COLUMN unified INTEGER NOT NULL DEFAULT 0')
  migrateMeetingChats(db)
}

/** Copy, never discard, legacy per-meeting turns. Safe to repeat after imports or reloads. */
export function migrateMeetingChats(db: DatabaseSync) {
  db.exec('SAVEPOINT meeting_chats')
  try {
    const meetings = db.prepare(`SELECT m.id, m.title, m.started_at AS first, coalesce(m.ended_at, m.started_at) AS last
      FROM chat_turns c JOIN meetings m ON m.id = c.meeting_id
      WHERE c.unified = 0 GROUP BY m.id`).all() as Row[]
    for (const m of meetings) {
      const chips: ContextChip[] = [{ kind: 'meeting', id: String(m.id) }]
      const key = contextKey(chips)
      const existing = db.prepare('SELECT id FROM conversations WHERE legacy_meeting_id = ?').get(String(m.id)) as Row | undefined
      const id = existing ? String(existing.id) : randomUUID()
      const current = db.prepare('SELECT 1 FROM conversations WHERE current_key = ?').get(key)
      if (!existing) db.prepare('INSERT INTO conversations (id,title,created_at,updated_at,chips,current_key,legacy_meeting_id) VALUES (?,?,?,?,?,?,?)')
        .run(id, String(m.title), Number(m.first), Number(m.last), JSON.stringify(chips), current ? null : key, String(m.id))
      db.prepare(`INSERT INTO conversation_turns (conversation_id, question, answer, stopped, asked_at)
        SELECT ?, question, answer, stopped, ? FROM chat_turns WHERE meeting_id = ? AND unified = 0 ORDER BY id`).run(id, Number(m.last), String(m.id))
      db.prepare('UPDATE conversations SET first_chips = coalesce(first_chips, chips) WHERE id = ?').run(id)
      db.prepare('UPDATE chat_turns SET unified = 1 WHERE meeting_id = ?').run(String(m.id))
    }
    db.exec('UPDATE conversations SET first_chips = chips WHERE first_chips IS NULL AND EXISTS (SELECT 1 FROM conversation_turns WHERE conversation_id = conversations.id)')
    db.exec('RELEASE meeting_chats')
  } catch (e) { db.exec('ROLLBACK TO meeting_chats; RELEASE meeting_chats'); throw e }
}

export type LibraryChunk = { id: number; meetingId: string; startMs: number; endMs: number; text: string; speakers: string[] }
export type ConversationRow = { id: string; title: string; createdAt: number; updatedAt: number; chips: ContextChip[]; draft: string; draftChips: ContextChip[]; firstChips: ContextChip[] | null }
export type TurnRow = { id: number; question: string; answer: string; stopped: boolean; waitingModel: boolean; sources: LibrarySource[] }

const toChunk = (r: Row): LibraryChunk => ({ id: Number(r.id), meetingId: String(r.meeting_id), startMs: Number(r.start_ms), endMs: Number(r.end_ms), text: String(r.text), speakers: JSON.parse(String(r.speakers)) })
const toConversation = (r: Row): ConversationRow => ({ id: String(r.id), title: String(r.title), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), chips: JSON.parse(String(r.chips)), draft: String(r.draft), draftChips: JSON.parse(String(r.draft_chips)), firstChips: r.first_chips == null ? null : JSON.parse(String(r.first_chips)) })
const asVector = (b: unknown) => { const u = b as Uint8Array; return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) }

/** Chunks, vectors and conversations over the Store's database (the tables come from libraryTables) */
export class Library {
  constructor(private db: DatabaseSync) {}

  /**
   * Finished meetings whose chunks are missing or were made from something else: their lines (shown ones), title or
   * people changed since. The signature is a hash of all that, so the check is one query, however many meetings.
   */
  stale(): Array<{ meetingId: string; signature: string }> {
    const rows = this.db.prepare(`SELECT m.id AS id, m.title AS title, m.attendees AS attendees, count(s.id) AS n, coalesce(sum(length(s.text)), 0) AS len,
      coalesce(sum(s.start_ms), 0) AS st, coalesce(sum(length(coalesce(s.speaker, ''))), 0) AS sp, ls.signature AS have
      FROM meetings m LEFT JOIN segments s ON s.meeting_id = m.id AND s.hidden = 0 LEFT JOIN library_sources ls ON ls.meeting_id = m.id
      WHERE m.state IN ('done', 'stopped') AND m.trashed_at IS NULL GROUP BY m.id ORDER BY m.started_at DESC`).all() as Row[]
    return rows.flatMap((r) => {
      const signature = createHash('sha1').update(`${r.n}:${r.len}:${r.st}:${r.sp}:${r.title}:${JSON.stringify(resolvePeople(this.db, JSON.parse(String(r.attendees))))}`).digest('hex')
      return r.have === signature ? [] : [{ meetingId: String(r.id), signature }]
    })
  }

  /** a meeting's chunks made again: the old ones (and their vectors) go */
  setChunks(meetingId: string, signature: string, people: string[], chunks: Chunk[]) {
    const ins = this.db.prepare('INSERT INTO library_chunks (meeting_id, start_ms, end_ms, text, speakers) VALUES (?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM library_chunks WHERE meeting_id = ?').run(meetingId)
      for (const c of chunks) ins.run(meetingId, c.startMs, c.endMs, c.text, JSON.stringify(c.speakers))
      this.db.prepare('INSERT INTO library_sources (meeting_id, signature, people) VALUES (?, ?, ?) ON CONFLICT(meeting_id) DO UPDATE SET signature = excluded.signature, people = excluded.people')
        .run(meetingId, signature, JSON.stringify(people))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  hasChunks(meetingId: string): boolean { return !!this.db.prepare('SELECT 1 FROM library_sources WHERE meeting_id = ?').get(meetingId) }

  /** chunks this model has not read yet, newest meetings first */
  unembedded(model: string, limit: number): Array<LibraryChunk & { title: string }> {
    return (this.db.prepare(`SELECT c.*, m.title AS title FROM library_chunks c JOIN meetings m ON m.id = c.meeting_id
      WHERE (c.vector IS NULL OR c.vector_model IS NOT ?) AND m.trashed_at IS NULL ORDER BY m.started_at DESC, c.start_ms LIMIT ?`).all(model, limit) as Row[])
      .map((r) => ({ ...toChunk(r), title: String(r.title) }))
  }
  setVector(id: number, model: string, v: Float32Array) {
    this.db.prepare('UPDATE library_chunks SET vector = ?, vector_model = ? WHERE id = ?').run(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), model, id)
  }
  /** every vector this model made (of the meetings given), none of a meeting in the Trash */
  vectors(model: string, meetingIds?: string[]): Array<{ id: number; meetingId: string; vector: Float32Array }> {
    const live = 'meeting_id NOT IN (SELECT id FROM meetings WHERE trashed_at IS NOT NULL)'
    const rows = meetingIds
      ? this.db.prepare(`SELECT id, meeting_id, vector FROM library_chunks WHERE vector_model = ? AND ${live} AND meeting_id IN (${meetingIds.map(() => '?').join(', ')})`).all(model, ...meetingIds)
      : this.db.prepare(`SELECT id, meeting_id, vector FROM library_chunks WHERE vector_model = ? AND ${live}`).all(model)
    return (rows as Row[]).filter((r) => r.vector != null).map((r) => ({ id: Number(r.id), meetingId: String(r.meeting_id), vector: asVector(r.vector) }))
  }
  /** the chunks asked for, in the order asked */
  chunks(ids: number[]): LibraryChunk[] {
    const get = this.db.prepare('SELECT * FROM library_chunks WHERE id = ?')
    return ids.flatMap((id) => { const r = get.get(id) as Row | undefined; return r ? [toChunk(r)] : [] })
  }
  /** a meeting's chunks in order */
  chunksOf(meetingId: string): LibraryChunk[] {
    return (this.db.prepare('SELECT * FROM library_chunks WHERE meeting_id = ? ORDER BY start_ms').all(meetingId) as Row[]).map(toChunk)
  }

  /**
   * Chunks holding any of the words (the transcript's own search index), best match first; one entry a chunk.
   * meetingIds narrows it to those meetings; at gets where in each chunk its best line starts.
   */
  wordHits(words: string[], meetingIds?: string[], limit = 300, at?: Map<number, number>): number[] {
    if (!words.length || meetingIds?.length === 0) return []
    const match = words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ')
    const within = meetingIds ? ` AND s.meeting_id IN (${meetingIds.map(() => '?').join(', ')})` : ''
    const segs = this.db.prepare(`SELECT s.meeting_id AS meeting_id, s.start_ms AS start_ms FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
      WHERE segments_fts MATCH ? AND s.hidden = 0${within} ORDER BY segments_fts.rank LIMIT ?`).all(match, ...(meetingIds ?? []), limit) as Row[]
    const of = this.db.prepare('SELECT id FROM library_chunks WHERE meeting_id = ? AND start_ms <= ? ORDER BY start_ms DESC LIMIT 1')
    const out = new Set<number>()
    for (const s of segs) {
      const r = of.get(String(s.meeting_id), Number(s.start_ms)) as Row | undefined
      if (!r || out.has(Number(r.id))) continue
      out.add(Number(r.id))
      at?.set(Number(r.id), Number(s.start_ms))
    }
    return [...out]
  }

  /** every finished meeting not in the Trash, newest first: what chat across meetings can search */
  finished(includeUnfinished = false): Array<{ id: string; title: string; startedAt: number; attendees: string[] }> {
    return (this.db.prepare(`SELECT id, title, started_at, attendees FROM meetings WHERE ${includeUnfinished ? '1' : "state IN ('done', 'stopped')"} AND trashed_at IS NULL ORDER BY started_at DESC, rowid DESC`).all() as Row[])
      .map((r) => ({ id: String(r.id), title: String(r.title), startedAt: Number(r.started_at), attendees: resolvePeople(this.db, JSON.parse(String(r.attendees))).map((a) => a.name).filter(Boolean) }))

  }

  /** who was in each indexed meeting: the invited and everyone who spoke */
  people(): Array<{ meetingId: string; people: string[] }> {
    return (this.db.prepare('SELECT meeting_id, people FROM library_sources').all() as Row[]).map((r) => ({ meetingId: String(r.meeting_id), people: JSON.parse(String(r.people)) }))
  }

  targets(query = ''): ContextTarget[] {
    const meetings = this.db.prepare("SELECT id,title,started_at FROM meetings WHERE trashed_at IS NULL AND instr(lower(title),lower(?)) > 0 ORDER BY started_at DESC LIMIT 40").all(query) as Row[]
    const folders = this.db.prepare("SELECT id,name FROM folders WHERE instr(lower(name),lower(?)) > 0 ORDER BY name LIMIT 40").all(query) as Row[]
    return [...meetings.map(r => ({ kind: 'meeting' as const, id: String(r.id), title: String(r.title), startedAt: Number(r.started_at) })),
      ...folders.map(r => ({ kind: 'folder' as const, id: String(r.id), title: String(r.name) }))]
  }
  describe(chips: ContextChip[]): ContextTarget[] {
    return chips.map(c => {
      const r = (c.kind === 'meeting' ? this.db.prepare('SELECT title,title_source FROM meetings WHERE id = ?') : this.db.prepare('SELECT name AS title FROM folders WHERE id = ?')).get(c.id) as Row | undefined
      return { ...c, title: r?.title_source === 'generic' ? '' : String(r?.title ?? '').trim() }
    })
  }
  scope(chips: ContextChip[]) {
    return chipScope(chips, id => !!this.db.prepare('SELECT 1 FROM meetings WHERE id = ? AND trashed_at IS NULL').get(id),
      id => (this.db.prepare('SELECT meeting_id FROM folder_meetings WHERE folder_id = ?').all(id) as Row[]).map(r => String(r.meeting_id)))
  }
  current(chips: ContextChip[], fresh = false): string {
    const key = contextKey(chips)
    const row = this.db.prepare('SELECT id FROM conversations WHERE current_key = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(key) as Row | undefined
    if (row && !fresh) return String(row.id)
    this.db.exec('SAVEPOINT current_conversation')
    try {
      const id = this.createConversation('')
      this.setContext(id, chips)
      this.db.exec('RELEASE current_conversation'); return id
    } catch (e) { this.db.exec('ROLLBACK TO current_conversation; RELEASE current_conversation'); throw e }
  }
  setContext(id: string, chips: ContextChip[]) {
    const chat = this.conversation(id)
    if (!chat) throw new Error('Conversation not found')
    if (chat.firstChips !== null) {
      const pending = attachContext([], chips).filter(c => !chat.chips.some(s => s.kind === c.kind && s.id === c.id))
      if (chat.chips.length + pending.length > 40) throw new Error('Too many context attachments')
      this.db.prepare('UPDATE conversations SET draft_chips = ? WHERE id = ?').run(JSON.stringify(pending), id)
      return
    }
    this.writeScope(id, attachContext([], chips))
  }
  removeContext(id: string, chip: ContextChip) {
    const chat = this.conversation(id)
    if (!chat) throw new Error('Conversation not found')
    const keep = (c: ContextChip) => c.kind !== chip.kind || c.id !== chip.id
    if (chat.chips.some(c => !keep(c))) this.writeScope(id, chat.chips.filter(keep))
    else this.setContext(id, chat.draftChips.filter(keep))
  }
  private writeScope(id: string, chips: ContextChip[]) {
    const key = contextKey(chips)
    this.db.exec('SAVEPOINT context_chips')
    try {
      this.db.prepare('UPDATE conversations SET current_key = NULL WHERE current_key = ?').run(key)
      this.db.prepare('UPDATE conversations SET chips = ?, current_key = ? WHERE id = ?').run(JSON.stringify(chips), key, id)
      this.db.exec('RELEASE context_chips')
    } catch (e) { this.db.exec('ROLLBACK TO context_chips; RELEASE context_chips'); throw e }
  }
  setDraft(id: string, draft: string) {
    if (!this.db.prepare('UPDATE conversations SET draft = ? WHERE id = ?').run(draft, id).changes) throw new Error('Conversation not found')
  }
  conversations(): ConversationRow[] {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC').all() as Row[]).map(toConversation)
  }
  conversation(id: string): ConversationRow | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined
    return r ? toConversation(r) : undefined
  }
  createConversation(title: string, now = Date.now()): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now)
    return id
  }
  renameConversation(id: string, title: string) { this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id) }
  deleteConversation(id: string) { this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id) }

  turns(conversationId: string): TurnRow[] {
    return (this.db.prepare('SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY id').all(conversationId) as Row[])
      .map((r) => ({ id: Number(r.id), question: String(r.question), answer: String(r.answer), stopped: Number(r.stopped) === 1, waitingModel: Number(r.waiting_model) === 1, sources: JSON.parse(String(r.sources)) }))
  }
  /** a question asked: the conversation comes to the top of the list */
  addTurn(conversationId: string, question: string, now = Date.now(), waitingModel = false): number {
    this.db.exec('SAVEPOINT ask_turn')
    try {
      const id = Number(this.db.prepare('INSERT INTO conversation_turns (conversation_id, question, asked_at, waiting_model) VALUES (?, ?, ?, ?)').run(conversationId, question, now, waitingModel ? 1 : 0).lastInsertRowid)
      const chat = this.conversation(conversationId)!
      if (chat.draftChips.length) this.writeScope(conversationId, attachContext(chat.chips, chat.draftChips))
      this.db.prepare("UPDATE conversations SET updated_at = ?, first_chips = coalesce(first_chips, chips), draft = '', draft_chips = '[]' WHERE id = ?").run(now, conversationId)
      this.db.exec('RELEASE ask_turn'); return id
    } catch (e) { this.db.exec('ROLLBACK TO ask_turn; RELEASE ask_turn'); throw e }
  }
  setTurn(id: number, answer: string, stopped: boolean, sources: LibrarySource[]) {
    this.db.prepare('UPDATE conversation_turns SET answer = ?, stopped = ?, sources = ?, waiting_model = 0 WHERE id = ?').run(answer, stopped ? 1 : 0, JSON.stringify(sources), id)
  }
  waitingTurns(): Array<{ conversationId: string; id: number; question: string }> {
    return (this.db.prepare('SELECT conversation_id, id, question FROM conversation_turns WHERE waiting_model = 1 ORDER BY id').all() as Row[])
      .map(r => ({ conversationId: String(r.conversation_id), id: Number(r.id), question: String(r.question) }))
  }
  startTurn(id: number) { this.db.prepare('UPDATE conversation_turns SET waiting_model = 0 WHERE id = ?').run(id) }
  deleteTurn(id: number) { this.db.prepare('DELETE FROM conversation_turns WHERE id = ?').run(id) }
}
