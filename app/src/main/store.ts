import { echoConfidence } from './asr/echo'
import { backfillPeople, rememberPeople, resolvePeople } from './people'
import { attendeeMembership, personEmail } from '../shared/people'
import type { FolderSuggestionRecord } from '../shared/folderSuggestion'
import { unusedPreparedNote } from '../shared/agendaNote'
import { speakerOrder } from '../shared/speakerColors'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { sourceOf, type TitleSource } from './titles'
import { libraryTables } from './library/store'
import { DEFAULT_FOLDER_APPEARANCE, isFolderIcon, isFolderColor, type FolderAppearance } from '../shared/folderAppearance'

type Row = Record<string, unknown>

export type Person = { name: string; email: string | null }
export type Meeting = {
  id: string; title: string; startedAt: number; endedAt: number | null; eventId: string | null
  /** Calendar lookup date can differ from the recording date after manual linking. */
  eventStartedAt?: number | null
  source?: string
  sourceId?: string
  app: string | null; attendees: Person[]; state: 'prepared' | 'recording' | 'stopped' | 'done'
  /** the language most of it was said in (whisper's name, e.g. "spanish"), once its transcript is done */
  language: string | null
  /** where the title came from: only a generic or auto one is replaced by a title from the notes */
  titleSource: TitleSource
  /** Recorded duration when pauses or resumed sessions make wall duration inaccurate. */
  durationMs?: number
  /** when it was moved to the Trash; there it is out of every list, search and chat until restored */
  trashedAt?: number
}
/** speaker: 'me' on the mic; on the other side the name the call app showed talking (callNames), null for Them */
export type Segment = { id: number; meetingId: string; track: 'me' | 'them'; startMs: number; endMs: number; text: string; speaker: string | null
  /** an echo of the other side found on the mic: kept, but out of the transcript, notes, search and export until shown again */
  hidden?: boolean
  /** High-confidence echo: retained for recovery, omitted from inline disclosures. */
  echoConfident?: boolean
  /** Shared display-only palette index, supplied by the transcript bridge. */
  speakerColor?: number }
export type Notes = { mine: string; enhanced: string | null; edited: boolean }

const toMeeting = (r: Row): Meeting => ({
  id: String(r.id), title: String(r.title), startedAt: Number(r.started_at), endedAt: r.ended_at == null ? null : Number(r.ended_at),
  eventId: r.event_id == null ? null : String(r.event_id), app: r.app == null ? null : String(r.app),
  attendees: JSON.parse(String(r.attendees)), state: r.state as Meeting['state'], language: r.language == null ? null : String(r.language),
  titleSource: (r.title_source ?? 'user') as TitleSource,
  ...(r.source == null ? {} : { source: String(r.source) }),
  ...(r.source_id == null ? {} : { sourceId: String(r.source_id) }),
  ...(r.event_started_at == null ? {} : { eventStartedAt: Number(r.event_started_at) }),
  ...(r.duration_ms == null ? {} : { durationMs: Number(r.duration_ms) }),
  ...(r.trashed_at == null ? {} : { trashedAt: Number(r.trashed_at) }),
})
const toSegment = (r: Row): Segment => ({
  id: Number(r.id), meetingId: String(r.meeting_id), track: r.track as Segment['track'], startMs: Number(r.start_ms), endMs: Number(r.end_ms),
  text: String(r.text), speaker: r.speaker == null ? null : String(r.speaker), hidden: Number(r.hidden ?? 0) === 1,
  ...(Number(r.echo_confident ?? 0) === 1 ? { echoConfident: true } : {}),
})

/** Chinese, Japanese and Korean letters: searched by pairs of characters (they have NOFOLDERS_P between words) */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** Plain words become quoted FTS5 terms, so stray quotes or operators in a search can't break the query. */
function ftsQuery(q: string): string {
  const words = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  // the last word may still be typing, so it matches as a prefix
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(' ')
}

/** A named group of meetings; a meeting can be in several. count: how many meetings are in it */
export type Folder = FolderAppearance & { id: string; name: string; createdAt: number; count: number }
const toFolder = (r: Row): Folder => ({ id: String(r.id), name: String(r.name), createdAt: Number(r.created_at), count: Number(r.count ?? 0), ...folderAppearance(r.icon, r.color) })
const folderAppearance = (icon: unknown, color: unknown): FolderAppearance => ({ icon: isFolderIcon(icon) ? icon : 'folder', color: isFolderColor(color) ? color : 'default' })
/** a meeting column's value is not a meeting in the Trash */
const notTrashed = (col: string) => ` AND ${col} NOT IN (SELECT id FROM meetings WHERE trashed_at IS NOT NULL)`
const FOLDER_COLS = `sp.*, (SELECT count(*) FROM folder_meetings x WHERE x.folder_id = sp.id${notTrashed('x.meeting_id')}) AS count`
/** a folder name: one line, trimmed, at most 200 characters; blank is no name */
const folderName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 200)

export type MeetingCard = Meeting & { /** the first words of the notes, plain text; empty with none yet */ preview: string; folders?: Array<Pick<Folder, 'id' | 'name' | 'icon' | 'color'>> }
export type SnippetPart = { text: string; hit: boolean }
export type SearchHit = { meetingId: string; snippet: string; parts: SnippetPart[] }

// where a matched word starts and ends in a snippet: characters no note or transcript contains
const OPEN = '\u0002', CLOSE = '\u0003'

/** Note Markdown as plain words: no heading or list marks, bold, links or <mine> tags */
function plainLine(line: string): string {
  return line.replace(/<\/?mine>/g, '').replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__/g, '').replace(/\\([\\*_[\]<#\-+.)])/g, '$1')
}
const HEADING_LINE = /^\s*#{1,6}\s+/
/** a heading ends with a dot between it and what follows, so "Budget" and "The Q3 budget…" don't run together */
const plain = (md: string) => md.split('\n').map((l) => plainLine(l) + (HEADING_LINE.test(l) && plainLine(l).trim() ? ' ·' : '')).join(' ').replace(/\s+/g, ' ').replace(/\s*·\s*$/, '').trim()

/** the first lines of the notes, headings left out (they say little on their own) */
function previewOf(enhanced: string | null, mine: string): string {
  const md = enhanced?.trim() ? enhanced : mine
  const body = md.split('\n').filter((l) => !HEADING_LINE.test(l)).join('\n')
  const text = plain(body.trim() ? body : md)
  return text.length > 240 ? text.slice(0, 240).replace(/\s+\S*$/, '') + '…' : text
}

/** Title words the way the text search sees them: whole words, the last one typed as a beginning; Chinese and Japanese anywhere */
function titleMatches(title: string, q: string): boolean {
  const split = (x: string) => x.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const words = split(q), have = split(title)
  return words.length > 0 && words.every((w, i) => CJK.test(w) ? title.includes(w) : i === words.length - 1 ? have.some((h) => h.startsWith(w)) : have.includes(w))
}

/** an FTS snippet with OPEN/CLOSE marks → pieces of plain text */
function partsOf(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  plain(snippet).split(OPEN).forEach((chunk, i) => {
    const [a, b] = i === 0 ? ['', chunk] : chunk.split(CLOSE).length > 1 ? [chunk.split(CLOSE)[0], chunk.split(CLOSE).slice(1).join('')] : [chunk, '']
    if (a) parts.push({ text: a, hit: true })
    if (b) parts.push({ text: b, hit: false })
  })
  return parts
}
const hitOf = (meetingId: string, parts: SnippetPart[]): SearchHit => ({ meetingId, parts, snippet: parts.map((p) => p.text).join('') })

/** pairs of characters in each run (one character alone when that is all there is) */
const pairsOf = (runs: string[]) => [...new Set(runs.flatMap((r) => (r.length < 2 ? [r] : Array.from({ length: r.length - 1 }, (_, i) => r.slice(i, i + 2)))))]

/** a short piece of text around the first pair, every pair in it marked */
function around(raw: string, pairs: string[]): SnippetPart[] {
  const text = plain(raw)
  const first = Math.max(0, text.indexOf(pairs[0]))
  const from = Math.max(0, first - 24), to = Math.min(text.length, first + 48)
  const piece = text.slice(from, to)
  const marked = new Array<boolean>(piece.length).fill(false)
  for (const p of pairs) for (let i = piece.indexOf(p); i !== -1; i = piece.indexOf(p, i + 1)) marked.fill(true, i, i + p.length)
  const parts: SnippetPart[] = []
  if (from > 0) parts.push({ text: '…', hit: false })
  for (let i = 0; i < piece.length; i++) {
    const last = parts.at(-1)
    if (last && last.hit === marked[i]) last.text += piece[i]
    else parts.push({ text: piece[i], hit: marked[i] })
  }
  if (to < text.length) parts.push({ text: '…', hit: false })
  return parts
}

/** Meetings, transcripts and notes in one SQLite file, with full-text search. */
export class Store {
  /** public only so tests can poke at tables */
  readonly db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, event_id TEXT, app TEXT,
        attendees TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, language TEXT);
      CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at);
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        track TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, speaker TEXT);
      CREATE INDEX IF NOT EXISTS segments_meeting ON segments(meeting_id, start_ms);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
        mine TEXT NOT NULL DEFAULT '', enhanced TEXT, edited INTEGER NOT NULL DEFAULT 0);

      CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(text, content='segments', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text); END;


      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(mine, enhanced, content='notes', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, mine, enhanced) VALUES (new.id, new.mine, new.enhanced); END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, mine, enhanced) VALUES ('delete', old.id, old.mine, old.enhanced); END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, mine, enhanced) VALUES ('delete', old.id, old.mine, old.enhanced);
        INSERT INTO notes_fts(rowid, mine, enhanced) VALUES (new.id, new.mine, new.enhanced); END;

      CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', stopped INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS chat_turns_meeting ON chat_turns(meeting_id, id);

      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      -- which meetings are in which folder: deleting either side drops the link, never the other side
      CREATE TABLE IF NOT EXISTS folder_meetings (
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL, PRIMARY KEY (folder_id, meeting_id));
      CREATE INDEX IF NOT EXISTS folder_meetings_meeting ON folder_meetings(meeting_id);
    `)
    const folderCols = (this.db.prepare('PRAGMA table_info(folders)').all() as Row[]).map((r) => r.name)
    if (!folderCols.includes('icon')) this.db.exec("ALTER TABLE folders ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'")
    if (!folderCols.includes('color')) this.db.exec("ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT 'default'")
    if (!folderCols.includes('position')) this.db.exec('ALTER TABLE folders ADD COLUMN position INTEGER')
    // notes tables made before "edited" existed (the developers' own copies) get it added
    const cols = (this.db.prepare('PRAGMA table_info(notes)').all() as Row[]).map((r) => String(r.name))
    if (!cols.includes('edited')) this.db.exec('ALTER TABLE notes ADD COLUMN edited INTEGER NOT NULL DEFAULT 0')
    const meetingCols = (this.db.prepare('PRAGMA table_info(meetings)').all() as Row[]).map((r) => String(r.name))
    for (const [name, type] of [['suggested_folder_id', 'TEXT'], ['suggestion_state', 'TEXT'], ['suggestion_confidence', 'REAL'], ['suggestion_attempt', 'TEXT']]) {
      if (!meetingCols.includes(name)) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`)
    }
    if (!meetingCols.includes('prepared_event_end')) this.db.exec('ALTER TABLE meetings ADD COLUMN prepared_event_end INTEGER')
    if (!meetingCols.includes('last_opened_at')) this.db.exec('ALTER TABLE meetings ADD COLUMN last_opened_at INTEGER')
    if (!meetingCols.includes('speaker_order')) this.db.exec("ALTER TABLE meetings ADD COLUMN speaker_order TEXT NOT NULL DEFAULT '[]'")
    for (const name of ['source', 'source_id']) if (!meetingCols.includes(name)) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${name} TEXT`)
    if (!meetingCols.includes('event_started_at')) this.db.exec('ALTER TABLE meetings ADD COLUMN event_started_at INTEGER')
    if (!meetingCols.includes('duration_ms')) this.db.exec('ALTER TABLE meetings ADD COLUMN duration_ms INTEGER')
    if (!meetingCols.includes('language')) this.db.exec('ALTER TABLE meetings ADD COLUMN language TEXT')
    if (!meetingCols.includes('trashed_at')) this.db.exec('ALTER TABLE meetings ADD COLUMN trashed_at INTEGER')
    if (!meetingCols.includes('title_source')) {
      // meetings from before: worked out from the title and the event, as a new one would be
      this.db.exec("ALTER TABLE meetings ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user'")
      const set = this.db.prepare('UPDATE meetings SET title_source = ? WHERE id = ?')
      for (const r of this.db.prepare('SELECT id, title, event_id FROM meetings').all() as Row[]) set.run(sourceOf(String(r.title), r.event_id == null ? null : String(r.event_id)), String(r.id))
    }
    // who was at the meeting when its notes were written (a "names" column from voice naming is left as it is, unread)
    if (!(this.db.prepare('PRAGMA table_info(notes)').all() as Row[]).some((r) => r.name === 'written_with')) this.db.exec('ALTER TABLE notes ADD COLUMN written_with TEXT')
    // the template this meeting's Summary is written with (shared/templates.ts); null: the one in Settings
    if (!(this.db.prepare('PRAGMA table_info(notes)').all() as Row[]).some((r) => r.name === 'template')) this.db.exec('ALTER TABLE notes ADD COLUMN template TEXT')
    const segmentCols = (this.db.prepare('PRAGMA table_info(segments)').all() as Row[]).map((r) => String(r.name))
    if (!segmentCols.includes('hidden')) this.db.exec('ALTER TABLE segments ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
    if (!segmentCols.includes('echo_confident')) {
      this.db.exec('BEGIN')
      try {
        this.db.exec('ALTER TABLE segments ADD COLUMN echo_confident INTEGER NOT NULL DEFAULT 0')
        // Old hidden lines lack span audio: only their strong word matches can be upgraded.
        const meetings = this.db.prepare('SELECT DISTINCT meeting_id FROM segments WHERE hidden = 1').all() as Row[]
        const mark = this.db.prepare('UPDATE segments SET echo_confident = 1 WHERE id = ?')
        for (const meeting of meetings) {
          const lines = this.segments(String(meeting.meeting_id), { hidden: true }), them = lines.filter(line => line.track === 'them')
          for (const line of lines) if (line.hidden && line.track === 'me' && echoConfidence(line, them, { echo: true }) === 'high') mark.run(line.id)
        }
        this.db.exec('COMMIT')
      } catch (e) { this.db.exec('ROLLBACK'); throw e }
    }
    // hidden lines are never in the search index, so their deletes and updates must not touch it (an FTS 'delete' of a row
    // that was never indexed corrupts the index). Made fresh on every open: a database from before keeps its old triggers otherwise.
    this.db.exec(`DROP TRIGGER IF EXISTS segments_au; DROP TRIGGER IF EXISTS segments_ad;
      CREATE TRIGGER segments_ad AFTER DELETE ON segments WHEN old.hidden = 0 BEGIN INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TRIGGER segments_au AFTER UPDATE OF text, speaker ON segments WHEN new.hidden = 0 BEGIN INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text); INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text); END;`)
    if (!(this.db.prepare('PRAGMA table_info(chat_turns)').all() as Row[]).some((r) => r.name === 'stopped')) this.db.exec('ALTER TABLE chat_turns ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0')
    const hadPeople = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people'").get()
    this.db.exec('CREATE TABLE IF NOT EXISTS people (email TEXT PRIMARY KEY, display_name TEXT, seen_names TEXT NOT NULL DEFAULT "[]", first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)')
    if (!hadPeople) backfillPeople(this.db)
    // chat across meetings: its chunks, vectors and saved conversations (library/store.ts)
    libraryTables(this.db)
    // voices told apart by letter (Speaker A, B) are gone: a database from then loses the letters, so those lines say Them
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'speakers'").get()) {
      this.db.exec("UPDATE segments SET speaker = NULL WHERE track = 'them'; DROP TABLE speakers")
    }
  }
  private readMeeting(r: Row): Meeting {
    const m = toMeeting(r)
    return { ...m, attendees: resolvePeople(this.db, m.attendees) }
  }
  renameAttendee(id: string, index: number, raw: string): boolean {
    const name = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
    const row = this.db.prepare('SELECT attendees FROM meetings WHERE id = ?').get(id)
    if (!row || !name || !Number.isInteger(index) || index < 0) return false
    const people = JSON.parse(String(row.attendees)) as Person[], person = people[index]
    if (!person) return false
    this.db.exec('SAVEPOINT rename_person')
    try {
      if (person.email) {
        rememberPeople(this.db, [person])
        this.db.prepare('UPDATE people SET display_name = ? WHERE email = ?').run(name, personEmail(person.email))
      } else {
        const previous = attendeeMembership(people)
        person.name = name
        this.db.prepare('UPDATE meetings SET attendees = ? WHERE id = ?').run(JSON.stringify(people), id)
        this.db.prepare('UPDATE notes SET written_with = ? WHERE meeting_id = ? AND written_with = ?').run(attendeeMembership(people), id, previous)
      }
      this.db.exec('RELEASE rename_person')
      return true
    } catch (e) { this.db.exec('ROLLBACK TO rename_person; RELEASE rename_person'); throw e }
  }
  close() { this.db.close() }

  createMeeting(m: Omit<Meeting, 'id' | 'language' | 'titleSource'> & { language?: string | null; titleSource?: TitleSource }): Meeting {
    const id = randomUUID()
    const language = m.language ?? null
    const titleSource = m.titleSource ?? sourceOf(m.title, m.eventId)
    this.db.prepare('INSERT INTO meetings (id, title, started_at, ended_at, event_id, app, attendees, state, language, title_source, duration_ms, event_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, m.title, m.startedAt, m.endedAt, m.eventId, m.app, JSON.stringify(m.attendees), m.state, language, titleSource, m.durationMs ?? null, m.eventStartedAt ?? null)
    rememberPeople(this.db, m.attendees)
    return { ...m, id, language, titleSource, attendees: resolvePeople(this.db, m.attendees) }
  }
  updateMeeting(id: string, patch: Partial<Omit<Meeting, 'id'>>) {
    if (patch.attendees) rememberPeople(this.db, patch.attendees)
    const col: Record<string, string> = { title: 'title', startedAt: 'started_at', endedAt: 'ended_at', eventId: 'event_id', eventStartedAt: 'event_started_at', app: 'app', attendees: 'attendees', state: 'state', language: 'language', titleSource: 'title_source', durationMs: 'duration_ms' }
    const keys = Object.keys(patch).filter((k) => k in col && (patch as Row)[k] !== undefined)
    if (!keys.length) return
    const vals = keys.map((k) => (k === 'attendees' ? JSON.stringify(patch.attendees) : (patch as Row)[k]) as string | number | null)
    this.db.prepare(`UPDATE meetings SET ${keys.map((k) => `${col[k]} = ?`).join(', ')} WHERE id = ?`).run(...vals, id)
  }
  /** Gone for good: its lines, notes and chat go with it (ON DELETE CASCADE; the search tables follow by trigger) */
  markPrepared(id: string, end: number) { this.db.prepare('UPDATE meetings SET prepared_event_end = ?, last_opened_at = ? WHERE id = ?').run(end, Date.now(), id) }
  noteOpened(id: string) { this.db.prepare('UPDATE meetings SET last_opened_at = ? WHERE id = ?').run(Date.now(), id) }
  tidyPrepared(now: number, keep: (id: string) => boolean): number {
    const rows = this.db.prepare(`SELECT m.*, n.mine, n.enhanced, n.edited,
      (SELECT count(*) FROM segments s WHERE s.meeting_id = m.id) AS segments,
      (SELECT count(*) FROM chat_turns c WHERE c.meeting_id = m.id) AS chats
      FROM meetings m LEFT JOIN notes n ON n.meeting_id = m.id WHERE m.state = 'prepared' AND m.trashed_at IS NULL`).all() as Row[]
    let removed = 0
    for (const r of rows) {
      if (!unusedPreparedNote({ state: String(r.state), eventEnd: r.prepared_event_end == null ? null : Number(r.prepared_event_end),
        openedAt: r.last_opened_at == null ? null : Number(r.last_opened_at), mine: String(r.mine ?? ''), enhanced: r.enhanced == null ? null : String(r.enhanced),
        segments: Number(r.segments), userEdited: !!r.edited || r.title_source === 'user' || Number(r.chats) > 0 }, now) || keep(String(r.id))) continue
      this.deleteMeeting(String(r.id)); removed++
    }
    return removed
  }
  deleteMeeting(id: string) { this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id) }
  /**
   * Moved to the Trash: everything of it stays (lines, notes, audio, its places in folders) so a restore puts it back
   * as it was, but every list, search and chat leaves it out. Never while it records. false: it wasn't moved.
   */
  trashMeeting(id: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE meetings SET trashed_at = ? WHERE id = ? AND state != 'recording' AND trashed_at IS NULL").run(now, id).changes) > 0
  }
  restoreMeeting(id: string) { this.db.prepare('UPDATE meetings SET trashed_at = NULL WHERE id = ?').run(id) }
  /** what is in the Trash, the last moved there first */
  trashed(): MeetingCard[] {
    const rows = this.db.prepare(`SELECT m.*, substr(n.mine, 1, 600) AS n_mine, substr(n.enhanced, 1, 600) AS n_enhanced FROM meetings m LEFT JOIN notes n ON n.meeting_id = m.id
      WHERE m.trashed_at IS NOT NULL ORDER BY m.trashed_at DESC, m.id`).all() as Row[]
    return rows.map((r) => ({ ...this.readMeeting(r), preview: previewOf(r.n_enhanced == null ? null : String(r.n_enhanced), r.n_mine == null ? '' : String(r.n_mine)) }))
  }
  /** meetings moved to the Trash before this time (due to be deleted for good) */
  trashedBefore(at: number): string[] {
    return (this.db.prepare('SELECT id FROM meetings WHERE trashed_at IS NOT NULL AND trashed_at < ? ORDER BY trashed_at').all(at) as Row[]).map((r) => String(r.id))
  }
  meeting(id: string): Meeting | undefined {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined
    return r ? this.readMeeting(r) : undefined
  }
  /** EventKit ids include the occurrence date, so recurring meetings keep separate notes. */
  meetingForEvent(eventId: string): Meeting | undefined {
    const r = this.db.prepare('SELECT * FROM meetings WHERE event_id = ? AND trashed_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1').get(eventId) as Row | undefined
    return r ? this.readMeeting(r) : undefined
  }
  meetings({ before, limit }: { before?: number; limit: number }): Meeting[] {
    const rows = before == null
      ? this.db.prepare('SELECT * FROM meetings WHERE trashed_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM meetings WHERE trashed_at IS NULL AND started_at < ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(before, limit)
    return (rows as Row[]).map(r => this.readMeeting(r))
  }

  addSegments(segs: Omit<Segment, 'id'>[]) {
    const ins = this.db.prepare('INSERT INTO segments (meeting_id, track, start_ms, end_ms, text, speaker, hidden, echo_confident) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const s of segs) {
        const r = ins.run(s.meetingId, s.track, s.startMs, s.endMs, s.text, s.speaker, s.hidden ? 1 : 0, s.hidden && s.echoConfident ? 1 : 0)
        // a hidden line is not for search
        if (s.hidden) this.db.prepare("INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', ?, ?)").run(r.lastInsertRowid, s.text)
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  /** the meeting's lines in order; hidden echo lines left out unless asked for */
  /** last: only the latest lines (the recorder's hover reads a recent tail, however long the meeting runs) */
  segments(meetingId: string, o: { hidden?: boolean; last?: number } = {}): Segment[] {
    const where = o.hidden ? 'meeting_id = ?' : 'meeting_id = ? AND hidden = 0'
    if (o.last) return (this.db.prepare(`SELECT * FROM (SELECT * FROM segments WHERE ${where} ORDER BY start_ms DESC, id DESC LIMIT ?) ORDER BY start_ms, id`).all(meetingId, o.last) as Row[]).map(toSegment)
    return (this.db.prepare(`SELECT * FROM segments WHERE ${where} ORDER BY start_ms, id`).all(meetingId) as Row[]).map(toSegment)
  }
  /** Full saved history establishes legacy colours; new names append even after late attribution. */
  speakerOrder(meetingId: string, arriving?: string | null): string[] {
    const row = this.db.prepare('SELECT speaker_order FROM meetings WHERE id = ?').get(meetingId) as Row | undefined
    if (!row) return []
    const previous = JSON.parse(String(row.speaker_order)) as string[]
    const names = arriving && previous.length ? [arriving] : (this.db.prepare(
      "SELECT speaker FROM segments WHERE meeting_id = ? AND track = 'them' AND speaker IS NOT NULL GROUP BY speaker ORDER BY MIN(start_ms), MIN(id)"
    ).all(meetingId) as Row[]).map(r => String(r.speaker))
    const next = speakerOrder(previous, [...names, arriving ?? null])
    if (next.length !== previous.length) {
      try { this.db.prepare('UPDATE meetings SET speaker_order = ? WHERE id = ?').run(JSON.stringify(next), meetingId) }
      catch (e) { console.warn('Could not save speaker colour order', e); return previous }
    }
    return next
  }
  /** Echo lines found after the meeting: hidden (kept in the store, out of the transcript and search), never deleted */
  hideSegments(ids: number[], confident: number[] = []) {
    if (!ids.length) return
    const get = this.db.prepare('SELECT id, text, hidden FROM segments WHERE id = ?'), up = this.db.prepare('UPDATE segments SET hidden = 1, echo_confident = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const id of ids) {
        const r = get.get(id) as Row | undefined
        if (!r || Number(r.hidden) === 1) continue
        up.run(confident.includes(id) ? 1 : 0, id)
        this.db.prepare("INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', ?, ?)").run(id, String(r.text))
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  /** The person wants the hidden lines back: all of a meeting's, or the ones given */
  showSegments(meetingId: string, ids?: number[]) {
    const rows = (this.db.prepare('SELECT id, text FROM segments WHERE meeting_id = ? AND hidden = 1').all(meetingId) as Row[]).filter((r) => !ids || ids.includes(Number(r.id)))
    if (!rows.length) return
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        this.db.prepare('UPDATE segments SET hidden = 0, echo_confident = 0 WHERE id = ?').run(Number(r.id))
        this.db.prepare('INSERT INTO segments_fts(rowid, text) VALUES (?, ?)').run(Number(r.id), String(r.text))
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** The language of the most recent meeting that has one (Apple's speech starts out listening in it) */
  lastLanguage(): string | null {
    const r = this.db.prepare('SELECT language FROM meetings WHERE language IS NOT NULL ORDER BY started_at DESC LIMIT 1').get() as Row | undefined
    return r?.language == null ? null : String(r.language)
  }

  /** Lines found to be echoes once the meeting is over (the mic's copy of the other side): gone, from search too (the fts trigger) */
  deleteSegments(ids: number[]) {
    if (!ids.length) return
    const del = this.db.prepare('DELETE FROM segments WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const id of ids) del.run(id)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** Who said each line, for the lines given (names from the call, settled after the meeting). */
  setSegmentSpeakers(list: Array<{ id: number; speaker: string | null }>) {
    const up = this.db.prepare('UPDATE segments SET speaker = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const s of list) up.run(s.speaker, s.id)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** edited: the person changed the enhanced notes since they were written */
  notes(meetingId: string): Notes {
    const r = this.db.prepare('SELECT mine, enhanced, edited FROM notes WHERE meeting_id = ?').get(meetingId) as Row | undefined
    return r ? { mine: String(r.mine), enhanced: r.enhanced == null ? null : String(r.enhanced), edited: Number(r.edited) === 1 } : { mine: '', enhanced: null, edited: false }
  }
  setNotes(meetingId: string, patch: Partial<Notes>) {
    const cur = this.notes(meetingId)
    const mine = patch.mine ?? cur.mine
    const enhanced = patch.enhanced === undefined ? cur.enhanced : patch.enhanced
    const edited = patch.edited ?? cur.edited
    this.db.prepare('INSERT INTO notes (meeting_id, mine, enhanced, edited) VALUES (?, ?, ?, ?) ON CONFLICT(meeting_id) DO UPDATE SET mine = excluded.mine, enhanced = excluded.enhanced, edited = excluded.edited')
      .run(meetingId, mine, enhanced, edited ? 1 : 0)
  }

  /** Who was at the meeting when the enhanced notes were last written (null: not recorded) */
  writtenWith(meetingId: string): string | null {
    const r = this.db.prepare('SELECT written_with FROM notes WHERE meeting_id = ?').get(meetingId) as Row | undefined
    return r?.written_with == null ? null : String(r.written_with)
  }
  setWrittenWith(meetingId: string, people: string) {
    this.db.prepare('UPDATE notes SET written_with = ? WHERE meeting_id = ?').run(people, meetingId)
  }

  /** The template this meeting's Summary is written with, as it was stored (null: none of its own, the one in Settings) */
  noteTemplate(meetingId: string): string | null {
    const r = this.db.prepare('SELECT template FROM notes WHERE meeting_id = ?').get(meetingId) as Row | undefined
    return r?.template == null ? null : String(r.template)
  }
  /** Picked for this meeting, or the one its Summary was just written with. A meeting with no notes yet gets its row. */
  setNoteTemplate(meetingId: string, template: string) {
    this.db.prepare('INSERT INTO notes (meeting_id, template) VALUES (?, ?) ON CONFLICT(meeting_id) DO UPDATE SET template = excluded.template').run(meetingId, template)
  }

  /** Stopped meetings with no enhanced notes: a quit or crash came before they were written */
  unenhancedMeetings(): Meeting[] {
    return (this.db.prepare(`SELECT * FROM meetings m WHERE state = 'stopped' AND trashed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.meeting_id = m.id AND n.enhanced IS NOT NULL) ORDER BY started_at`).all() as Row[]).map(r => this.readMeeting(r))
  }

  /** Past meetings for the home screen, newest first, a page at a time: before is the last card of the page before */
  meetingCards({ before, limit, folder }: { before?: { at: number; id: string }; limit: number; /** only the meetings in this folder */ folder?: string }): MeetingCard[] {
    const cols = `m.*, substr(n.mine, 1, 600) AS n_mine, substr(n.enhanced, 1, 600) AS n_enhanced,
      (SELECT json_group_array(json_object('id', id, 'name', name, 'icon', icon, 'color', color)) FROM
        (SELECT f.id, f.name, f.icon, f.color FROM folders f JOIN folder_meetings fm ON fm.folder_id = f.id
          WHERE fm.meeting_id = m.id ORDER BY f.name COLLATE NOCASE, f.created_at)) AS card_folders`
    const from = `FROM meetings m LEFT JOIN notes n ON n.meeting_id = m.id${folder == null ? '' : ' JOIN folder_meetings sm ON sm.meeting_id = m.id AND sm.folder_id = ?'} WHERE m.trashed_at IS NULL`
    const sp = folder == null ? [] : [folder]
    const rows = before == null
      ? this.db.prepare(`SELECT ${cols} ${from} ORDER BY m.started_at DESC, m.id DESC LIMIT ?`).all(...sp, limit)
      : this.db.prepare(`SELECT ${cols} ${from} AND (m.started_at < ? OR (m.started_at = ? AND m.id < ?)) ORDER BY m.started_at DESC, m.id DESC LIMIT ?`)
        .all(...sp, before.at, before.at, before.id, limit)
    return (rows as Row[]).map((r) => ({
      ...this.readMeeting(r),
      folders: (JSON.parse(String(r.card_folders)) as Row[]).map(f => ({ id: String(f.id), name: String(f.name), ...folderAppearance(f.icon, f.color) })),
      preview: previewOf(r.n_enhanced == null ? null : String(r.n_enhanced), r.n_mine == null ? '' : String(r.n_mine)),
    }))
  }
  /** The first words of a meeting's notes as plain text (enhanced when written, else the person's own) */
  preview(meetingId: string): string {
    const n = this.notes(meetingId)
    return previewOf(n.enhanced, n.mine)
  }

  /**
   * Meetings whose title, transcript or notes contain the words; one hit per meeting. Titles first (newest first),
   * then the best text matches. parts: the snippet in pieces, hit on the words matched, plain text only (the
   * window shows them as text, never as markup). folder: only the meetings in that folder.
   */
  search(q: string, limit: number, folder?: string): SearchHit[] {
    const fts = ftsQuery(q)
    if (!fts) return []
    // narrowed to a folder: every query below keeps only its meetings (the folder id is the last argument of each)
    // and never a meeting in the Trash
    const inFolder = (col: string) => notTrashed(col) + (folder == null ? '' : ` AND ${col} IN (SELECT meeting_id FROM folder_meetings WHERE folder_id = ?)`)
    const sp = folder == null ? [] : [folder]
    const out = new Map<string, SearchHit>()
    const add = (id: string, parts: SnippetPart[]) => {
      if (out.has(id)) { if (!out.get(id)!.parts.length && parts.length) out.set(id, hitOf(id, parts)); return }
      out.set(id, hitOf(id, parts))
    }
    const titled = (this.db.prepare(`SELECT id, title FROM meetings WHERE 1${inFolder('id')} ORDER BY started_at DESC, id DESC`).all(...sp) as Row[])
      .filter((r) => titleMatches(String(r.title), q)).slice(0, limit)
    for (const r of titled) out.set(String(r.id), hitOf(String(r.id), []))
    const rows = this.db.prepare(`
      SELECT meeting_id, snippet, MIN(rank) AS best FROM (
        SELECT s.meeting_id AS meeting_id, snippet(segments_fts, 0, '${OPEN}', '${CLOSE}', '…', 12) AS snippet, segments_fts.rank AS rank
          FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid WHERE segments_fts MATCH ? AND s.hidden = 0${inFolder('s.meeting_id')}
        UNION ALL
        SELECT n.meeting_id, snippet(notes_fts, -1, '${OPEN}', '${CLOSE}', '…', 12), notes_fts.rank
          FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ?${inFolder('n.meeting_id')}
      ) GROUP BY meeting_id ORDER BY best LIMIT ?`).all(fts, ...sp, fts, ...sp, limit) as Row[]
    for (const r of rows) add(String(r.meeting_id), partsOf(String(r.snippet)))
    // Chinese and Japanese: NOFOLDERS_P, so the search sees a whole run as one word; lines with every pair of the characters match
    const runs = q.match(CJK_RUNS) ?? []
    if (runs.length && out.size < limit) {
      const pairs = pairsOf(runs)
      const where = (col: string) => pairs.map(() => `instr(${col}, ?) > 0`).join(' AND ')
      const found = [
        ...(this.db.prepare(`SELECT meeting_id, text FROM segments WHERE hidden = 0 AND ${where('text')}${inFolder('meeting_id')} ORDER BY meeting_id, start_ms LIMIT 500`).all(...pairs, ...sp) as Row[]),
        ...(this.db.prepare(`SELECT meeting_id, coalesce(enhanced, '') || char(10) || mine AS text FROM notes WHERE ${where("coalesce(enhanced, '') || char(10) || mine")}${inFolder('meeting_id')} LIMIT 500`).all(...pairs, ...sp) as Row[]),
      ]
      for (const r of found) if (out.size < limit && !out.get(String(r.meeting_id))?.parts.length) add(String(r.meeting_id), around(String(r.text), pairs))
    }
    return [...out.values()].slice(0, limit)
  }

  /**
   * The meeting's lines with any of the question's words, best match first (chat: the turns that matter when the
   * whole transcript doesn't fit). Any word, not all: a question says much more than the line it is about.
   * Chinese and Japanese have NOFOLDERS_P, so the search can't see their words: lines sharing pairs of their
   * characters come after, most pairs first.
   */
  segmentHits(meetingId: string, question: string, limit = 200): number[] {
    const words = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || CJK.test(w)))]
    if (!words.length) return []
    const found = (this.db.prepare(`SELECT s.id AS id FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
      WHERE segments_fts MATCH ? AND s.meeting_id = ? AND s.hidden = 0 ORDER BY segments_fts.rank LIMIT ?`).all(words.map((w) => `"${w}"`).join(' OR '), meetingId, limit) as Row[])
      .map((r) => Number(r.id))
    const runs = question.match(CJK_RUNS) ?? []
    if (!runs.length) return found
    const pairs = pairsOf(runs)
    const seen = new Set(found)
    const scored = (this.db.prepare('SELECT id, text FROM segments WHERE meeting_id = ? AND hidden = 0').all(meetingId) as Row[])
      .map((r) => ({ id: Number(r.id), n: pairs.filter((p) => String(r.text).includes(p)).length }))
      .filter((x) => x.n && !seen.has(x.id)).sort((a, b) => b.n - a.n)
    return [...found, ...scored.map((x) => x.id)].slice(0, limit)
  }

  /** A meeting's chat: each question and its answer, oldest first; stopped: the person stopped it partway */
  chatTurns(meetingId: string): Array<{ id: number; question: string; answer: string; stopped: boolean }> {
    return (this.db.prepare('SELECT id, question, answer, stopped FROM chat_turns WHERE meeting_id = ? ORDER BY id').all(meetingId) as Row[])
      .map((r) => ({ id: Number(r.id), question: String(r.question), answer: String(r.answer), stopped: Number(r.stopped) === 1 }))
  }
  addChatTurn(meetingId: string, question: string): number {
    return Number(this.db.prepare('INSERT INTO chat_turns (meeting_id, question) VALUES (?, ?)').run(meetingId, question).lastInsertRowid)
  }
  setChatAnswer(id: number, answer: string, stopped = false) { this.db.prepare('UPDATE chat_turns SET answer = ?, stopped = ? WHERE id = ?').run(answer, stopped ? 1 : 0, id) }
  deleteChatTurn(id: number) { this.db.prepare('DELETE FROM chat_turns WHERE id = ?').run(id) }
  clearChat(meetingId: string) { this.db.prepare('DELETE FROM chat_turns WHERE meeting_id = ?').run(meetingId) }

  /** The chosen order, or alphabetical until the first reorder. */
  folders(): Folder[] {
    return (this.db.prepare(`SELECT ${FOLDER_COLS} FROM folders sp ORDER BY sp.position IS NULL, sp.position, sp.name COLLATE NOCASE, sp.created_at`).all() as Row[]).map(toFolder)
  }
  reorderFolders(ids: string[]): boolean {
    const current = this.folders().map(f => f.id)
    const chosen = new Set(ids)
    if (ids.length !== current.length || chosen.size !== ids.length || current.some(id => !chosen.has(id))) return false
    const set = this.db.prepare('UPDATE folders SET position = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      ids.forEach((id, position) => set.run(position, id))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return true
  }
  folder(id: string): Folder | undefined {
    const r = this.db.prepare(`SELECT ${FOLDER_COLS} FROM folders sp WHERE sp.id = ?`).get(id) as Row | undefined
    return r ? toFolder(r) : undefined
  }
  createFolder(name: string, appearance: FolderAppearance = DEFAULT_FOLDER_APPEARANCE): Folder {
    const s = { id: randomUUID(), name: folderName(name), createdAt: Date.now(), count: 0, icon: appearance.icon, color: appearance.color }
    this.db.prepare('INSERT INTO folders (id, name, created_at, icon, color, position) VALUES (?, ?, ?, ?, ?, (SELECT MAX(position) + 1 FROM folders))').run(s.id, s.name, s.createdAt, s.icon, s.color)
    return s
  }
  setFolderAppearance(id: string, appearance: FolderAppearance) {
    this.db.prepare('UPDATE folders SET icon = ?, color = ? WHERE id = ?').run(appearance.icon, appearance.color, id)
  }
  /** a blank name keeps the one it had */
  renameFolder(id: string, name: string) {
    const n = folderName(name)
    if (n) this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(n, id)
  }
  /** The folder goes; its meetings stay where they are (only the links go, by ON DELETE CASCADE) */
  deleteFolder(id: string) { this.db.prepare('DELETE FROM folders WHERE id = ?').run(id) }
  /** in a folder already: nothing changes */
  addToFolder(folderId: string, meetingId: string) {
    this.db.exec('SAVEPOINT file_meeting')
    try {
      this.db.prepare('INSERT OR IGNORE INTO folder_meetings (folder_id, meeting_id, added_at) VALUES (?, ?, ?)').run(folderId, meetingId, Date.now())
      this.db.prepare("UPDATE meetings SET suggestion_state = CASE WHEN suggested_folder_id = ? THEN 'accepted' ELSE 'dismissed' END WHERE id = ? AND suggestion_state = 'pending'").run(folderId, meetingId)
      this.db.exec('RELEASE file_meeting')
    } catch (e) { this.db.exec('ROLLBACK TO file_meeting; RELEASE file_meeting'); throw e }
  }
  folderSuggestion(id: string): FolderSuggestionRecord {
    const r = this.db.prepare('SELECT suggested_folder_id, suggestion_state, suggestion_confidence, suggestion_attempt FROM meetings WHERE id = ?').get(id) as Row | undefined
    return { folderId: r?.suggested_folder_id == null ? null : String(r.suggested_folder_id), state: (r?.suggestion_state ?? null) as FolderSuggestionRecord['state'], confidence: r?.suggestion_confidence == null ? null : Number(r.suggestion_confidence), attempted: r?.suggestion_attempt == null ? null : String(r.suggestion_attempt) }
  }
  saveFolderSuggestion(id: string, result: { folderId: string | null; confidence: number | null }, attempt: string) {
    this.db.prepare('UPDATE meetings SET suggested_folder_id = ?, suggestion_state = ?, suggestion_confidence = ?, suggestion_attempt = ? WHERE id = ? AND suggestion_state IS NULL')
      .run(result.folderId, result.folderId ? 'pending' : null, result.confidence, attempt, id)
  }
  dismissFolderSuggestion(id: string) {
    this.db.prepare("UPDATE meetings SET suggestion_state = 'dismissed' WHERE id = ? AND suggestion_state = 'pending'").run(id)
  }
  removeFromFolder(folderId: string, meetingId: string) { this.db.prepare('DELETE FROM folder_meetings WHERE folder_id = ? AND meeting_id = ?').run(folderId, meetingId) }
  /** the folders a meeting is in, by name */
  foldersOf(meetingId: string): Folder[] {
    return (this.db.prepare(`SELECT ${FOLDER_COLS} FROM folders sp JOIN folder_meetings l ON l.folder_id = sp.id WHERE l.meeting_id = ? ORDER BY sp.name COLLATE NOCASE, sp.created_at`).all(meetingId) as Row[]).map(toFolder)
  }
  /** The meetings in a folder, newest first: what a question about the whole folder would read */
  folderMeetingIds(folderId: string): string[] {
    return (this.db.prepare('SELECT m.id FROM meetings m JOIN folder_meetings l ON l.meeting_id = m.id WHERE l.folder_id = ? AND m.trashed_at IS NULL ORDER BY m.started_at DESC, m.id DESC').all(folderId) as Row[]).map((r) => String(r.id))
  }

  /** After a crash or quit mid-recording: those meetings are stopped, not still recording. */
  markInterrupted(): number {
    return Number(this.db.prepare("UPDATE meetings SET state = 'stopped' WHERE state = 'recording'").run().changes)
  }
}

export function openStore(file: string): Store { return new Store(file) }
