import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore, type Store } from '../src/main/store'
import { BACKUP_FORMAT, carriedTables, checkManifest, exportBackup, importBackup, meetingTables, mergeBackup } from '../src/main/backup'
import { Library } from '../src/main/library/store'
import { pack, packPortable, unpack, unpackPortable } from '../src/main/zip'

vi.mock('../src/main/zip', async (original) => {
  const actual = await original<typeof import('../src/main/zip')>()
  return { ...actual, pack: vi.fn(actual.pack), unpack: vi.fn(actual.unpack) }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) }
})

const dirs: string[] = []
const stores: Store[] = []
beforeEach(() => vi.resetAllMocks())
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-backup-')); dirs.push(d); return d }
function fresh(): Store {
  const s = openStore(join(tmp(), 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  // Fault tests deliberately leave temporary directories behind when cleanup is denied.
  for (const [path] of vi.mocked(rm).mock.calls) rmSync(path, { recursive: true, force: true })
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { endedAt: 2000, eventId: null, app: null, attendees: [{ name: 'Ann Lee', email: null }], state: 'done' as const }

/** a meeting with something in every table: lines (one hidden, one with a name from the call), notes and a chat turn */
function fill(s: Store, title: string, word: string) {
  const m = s.createMeeting({ ...base, title, startedAt: 1000 })
  s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 900, text: `We talked about the ${word} plan`, speaker: 'Bo Park' },
    { meetingId: m.id, track: 'me', startMs: 1000, endMs: 1900, text: 'an echo nobody should find', speaker: null, hidden: true, echoConfident: true },
  ])
  s.setNotes(m.id, { mine: `my ${word} notes`, enhanced: `## ${word}\n- done` })
  s.addChatTurn(m.id, `what about the ${word}?`)
  return m
}

describe('backup merge', () => {
  it('a backup from when voices had letters: its lines of the other side come in as Them', () => {
    const from = fresh(), into = fresh()
    const m = fill(from, 'Old', 'letters')
    from.db.exec("CREATE TABLE speakers (meeting_id TEXT, label TEXT, name TEXT)")
    from.db.prepare("UPDATE segments SET speaker = 'A' WHERE track = 'them'").run()
    mergeBackup(into.db, from.db)
    expect(into.segments(m.id).map((s) => s.speaker)).toEqual([null])
  })
  it('adds meetings that are not here with every row that belongs to them, and skips the ones that are', () => {
    const from = fresh(), into = fresh()
    const shared = fill(from, 'Weekly sync', 'budget')
    const fresh1 = fill(from, 'Pricing', 'pricing')
    from.updateMeeting(fresh1.id, { eventId: 'next-day-event', eventStartedAt: 86_401_000 })
    const colours = from.speakerOrder(fresh1.id)
    // the same meeting is already here, with notes the person changed since: never overwritten
    into.db.prepare('INSERT INTO meetings (id, title, started_at, attendees, state) VALUES (?, ?, ?, ?, ?)').run(shared.id, 'My own title', 1, '[]', 'done')
    into.setNotes(shared.id, { mine: 'kept as it is' })
    const mine = fill(into, 'Mine', 'roadmap')

    const r = mergeBackup(into.db, from.db)
    expect(r).toEqual({ added: [fresh1.id], skipped: 1 })
    expect(into.meeting(shared.id)?.title).toBe('My own title')
    expect(into.notes(shared.id).mine).toBe('kept as it is')
    expect(into.meeting(fresh1.id)).toMatchObject({ eventId: 'next-day-event', eventStartedAt: 86_401_000, title: 'Pricing', attendees: [{ name: 'Ann Lee', email: null }], state: 'done' })
    expect(into.segments(fresh1.id).map((s) => s.text)).toEqual(['We talked about the pricing plan'])
    expect(into.segments(fresh1.id, { hidden: true })).toHaveLength(2)
    expect(into.segments(fresh1.id).map((s) => s.speaker)).toEqual(['Bo Park'])
    expect(into.speakerOrder(fresh1.id)).toEqual(colours)
    expect(into.notes(fresh1.id)).toMatchObject({ mine: 'my pricing notes', enhanced: '## pricing\n- done' })
    expect(into.chatTurns(fresh1.id).map((c) => c.question)).toEqual(['what about the pricing?'])
    // the person's own meeting is untouched, its lines keep their ids
    expect(into.segments(mine.id, { hidden: true })).toHaveLength(2)
    // twice adds nothing
    expect(mergeBackup(into.db, from.db)).toEqual({ added: [], skipped: 2 })
  })

  it('finds imported text in search, never the hidden lines', () => {
    const from = fresh(), into = fresh()
    fill(into, 'Mine', 'roadmap')
    const m = fill(from, 'Pricing', 'pricing')
    mergeBackup(into.db, from.db)
    expect(into.search('pricing plan', 10).map((h) => h.meetingId)).toContain(m.id)
    expect(into.search('pricing notes', 10).map((h) => h.meetingId)).toContain(m.id)
    expect(into.search('echo nobody', 10)).toEqual([])
    expect(into.segments(m.id, { hidden: true }).find(line => line.hidden)?.echoConfident).toBe(true)
    // the index is still sound: changing an imported line's words moves the search with it
    const line = into.segments(m.id)[0]
    into.db.prepare('UPDATE segments SET text = ? WHERE id = ?').run('A totally new sentence', line.id)
    expect(into.search('totally new', 10).map((h) => h.meetingId)).toEqual([m.id])
    into.deleteMeeting(m.id)
    expect(into.db.prepare("INSERT INTO segments_fts(segments_fts) VALUES ('integrity-check')").run()).toBeTruthy()
  })

  it('ignores columns this version does not know, and gives ones the backup lacks their defaults', () => {
    const into = fresh()
    // an older backup: no language, labelled_at, hidden, edited or stopped; and a column from some newer version
    const d = tmp()
    const old = new DatabaseSync(join(d, 'old.db'))
    old.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER, ended_at INTEGER, event_id TEXT, app TEXT, attendees TEXT, state TEXT, mood TEXT);
      CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, track TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT, speaker TEXT, colour TEXT);
      CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, mine TEXT, enhanced TEXT);
      CREATE TABLE stickers (meeting_id TEXT, emoji TEXT);
      INSERT INTO meetings VALUES ('m1', 'Old one', 5, 6, NULL, NULL, '[]', 'recording', 'happy');
      INSERT INTO segments (meeting_id, track, start_ms, end_ms, text, speaker, colour) VALUES ('m1', 'me', 0, 10, 'hello from the past', NULL, 'red');
      INSERT INTO notes (meeting_id, mine, enhanced) VALUES ('m1', 'old notes', NULL);
      INSERT INTO stickers VALUES ('m1', 'x');`)
    expect(mergeBackup(into.db, old)).toEqual({ added: ['m1'], skipped: 0 })
    old.close()
    // a meeting that was still recording in the backup comes back stopped, like after a crash
    expect(into.meeting('m1')).toMatchObject({ title: 'Old one', language: null, state: 'stopped' })
    expect(into.segments('m1')).toMatchObject([{ text: 'hello from the past', hidden: false }])
    expect(into.notes('m1')).toEqual({ mine: 'old notes', enhanced: null, edited: false })
    expect(into.search('past', 10).map((h) => h.meetingId)).toEqual(['m1'])
  })

  it('imports nothing when one row fails', () => {
    const into = fresh()
    fill(into, 'Mine', 'roadmap')
    const d = tmp()
    const bad = new DatabaseSync(join(d, 'bad.db'))
    bad.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER, attendees TEXT, state TEXT);
      CREATE TABLE segments (id INTEGER PRIMARY KEY, meeting_id TEXT, track TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT);
      INSERT INTO meetings VALUES ('ok', 'Fine', 1, '[]', 'done'), ('m2', 'Broken', 2, '[]', 'done');
      INSERT INTO segments VALUES (1, 'ok', 'me', 0, 1, 'fine line'), (2, 'm2', 'me', 0, 1, NULL);`)
    expect(() => mergeBackup(into.db, bad)).toThrow()
    bad.close()
    expect(into.meetings({ limit: 10 }).map((m) => m.title)).toEqual(['Mine'])
    expect(into.search('fine line', 10)).toEqual([])
  })

  it('knows every table that holds a meeting\'s rows, and every table is one of them', () => {
    const s = fresh()
    expect(meetingTables(s.db).map((t) => t.table).sort()).toEqual(['chat_turns', 'folder_meetings', 'library_chunks', 'library_sources', 'notes', 'segments'])
    // a new table that is not tied to a meeting would be left out of backups: decide what a backup does with it, then list it here
    const all = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(all.filter((t) => t !== 'meetings' && !meetingTables(s.db).some((m) => m.table === t)).sort()).toEqual(['conversation_turns', 'conversations', 'folders', 'people'])
    // those are carried on their own: a conversation and every turn of it, and folders (test/folders.test.ts)
    expect(carriedTables(s.db)).toEqual([{ table: 'conversations', column: 'id' }, { table: 'conversation_turns', column: 'conversation_id' }, { table: 'folders', column: 'id' }])
  })

  it('brings the chats across meetings that are not here, with their turns and sources, and never changes one that is', () => {
    const from = fresh(), into = fresh()
    const ours = new Library(from.db), theirs = new Library(into.db)
    const a = ours.createConversation('Pricing', 1000)
    ours.setTurn(ours.addTurn(a, 'what about pricing?', 1000), 'Twenty dollars [1].', false, [{ n: 1, meetingId: 'm1', title: 'Pricing', startedAt: 5, atMs: 6000 }])
    const b = ours.createConversation('Hiring', 2000)
    ours.addTurn(b, 'who did we hire?', 2000)
    // b is already here, renamed: kept as it is
    into.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(b, 'Mine', 1, 1)
    fill(from, 'A meeting', 'word')
    mergeBackup(into.db, from.db)
    expect(theirs.conversations().map((c) => c.title).sort()).toEqual(['A meeting', 'Mine', 'Pricing'])
    expect(theirs.turns(a)).toMatchObject([{ question: 'what about pricing?', answer: 'Twenty dollars [1].', sources: [{ n: 1, meetingId: 'm1' }] }])
    expect(theirs.turns(b)).toEqual([])
    // twice adds nothing
    mergeBackup(into.db, from.db)
    expect(theirs.turns(a)).toHaveLength(1)
  })
})

describe('backup manifest', () => {
  it('takes this format and older, refuses a newer one, and anything else is not a backup', () => {
    expect(checkManifest({ format: BACKUP_FORMAT, app: '0.1.0', createdAt: 1, meetings: 2 })).toBe('ok')
    expect(checkManifest({ format: BACKUP_FORMAT + 1, app: '9.0.0', createdAt: 1, meetings: 2 })).toBe('newer')
    expect(checkManifest({ app: 'x' })).toBe('invalid')
    expect(checkManifest(null)).toBe('invalid')
    expect(checkManifest({ format: 'one' })).toBe('invalid')
  })
})

// real files and zips: a busy Windows runner can take over the default 5 s
describe('backup file', { timeout: 20_000 }, () => {
  it('reports an import preparation failure as a failure result, without adding meetings', async () => {
    const s = fresh()
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('ENOSPC'))
    expect(await importBackup({ db: s.db, meetingsDir: tmp(), zip: '/unused.zip' })).toEqual({ ok: false, error: 'failed' })
    expect(s.meetings({ limit: 10 })).toEqual([])
  })

  it('does not mistake an extraction I/O error for proof that the backup is invalid', async () => {
    const s = fresh()
    vi.mocked(unpack).mockRejectedValueOnce(new Error('ENOSPC: extraction failed'))
    expect(await importBackup({ db: s.db, meetingsDir: tmp(), zip: '/unreadable.zip' })).toEqual({ ok: false, error: 'failed' })
  })

  it('keeps the successful export result when cleaning its staging directory fails', async () => {
    const s = fresh(), out = join(tmp(), 'backup.zip')
    fill(s, 'Saved', 'saved')
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'))
    expect(await exportBackup({ db: s.db, meetingsDir: tmp(), out, appVersion: '1' })).toEqual({ meetings: 1 })
    const restored = fresh()
    expect(await importBackup({ db: restored.db, meetingsDir: tmp(), zip: out })).toEqual({ ok: true, added: 1, skipped: 0 })
  })

  it('keeps the successful import result when cleaning extracted files fails after commit', async () => {
    const s = fresh(), restored = fresh(), out = join(tmp(), 'backup.zip')
    const m = fill(s, 'Imported', 'imported')
    await exportBackup({ db: s.db, meetingsDir: tmp(), out, appVersion: '1' })
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'))
    expect(await importBackup({ db: restored.db, meetingsDir: tmp(), zip: out })).toEqual({ ok: true, added: 1, skipped: 0 })
    expect(restored.meeting(m.id)?.title).toBe('Imported')
    expect(await importBackup({ db: restored.db, meetingsDir: tmp(), zip: out })).toEqual({ ok: true, added: 0, skipped: 1 })
  })

  it.each([false, true])('keeps an existing backup and the original export error even if cleanup fails: %s', async (cleanupFails) => {
    const s = fresh(), dest = tmp(), out = join(dest, 'Yogurt backup.zip')
    fill(s, 'New meeting', 'new')
    const original = Buffer.from('previous backup bytes that must survive')
    writeFileSync(out, original)
    vi.mocked(pack).mockImplementationOnce(async (_dir, archive) => {
      // A compressor can write some bytes before disk-full or another write failure.
      writeFileSync(archive, 'incomplete replacement')
      throw new Error('ENOSPC: archive write failed')
    })
    if (cleanupFails) vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'))
    await expect(exportBackup({ db: s.db, meetingsDir: tmp(), out, appVersion: '1.2.3' })).rejects.toThrow('ENOSPC')
    expect(readFileSync(out)).toEqual(original)
    expect(readdirSync(dest)).toEqual(['Yogurt backup.zip'])
  })

  it('successfully replaces the same backup path with a complete, importable archive', async () => {
    const s = fresh(), dest = tmp(), out = join(dest, 'Yogurt backup.zip'), recordings = tmp()
    const first = fill(s, 'First meeting', 'first')
    await exportBackup({ db: s.db, meetingsDir: recordings, out, appVersion: '1.2.3', now: 1 })
    const original = readFileSync(out)
    const second = fill(s, 'Second meeting', 'second')
    expect(await exportBackup({ db: s.db, meetingsDir: recordings, out, appVersion: '1.2.3', now: 2 })).toEqual({ meetings: 2 })
    expect(readFileSync(out)).not.toEqual(original)
    expect(readdirSync(dest)).toEqual(['Yogurt backup.zip'])
    const restored = fresh()
    expect(await importBackup({ db: restored.db, meetingsDir: tmp(), zip: out })).toEqual({ ok: true, added: 2, skipped: 0 })
    expect(restored.meeting(first.id)?.title).toBe('First meeting')
    expect(restored.meeting(second.id)?.title).toBe('Second meeting')
  })

  it('exports the database, the recordings and a manifest to one zip, and imports it into an empty Yogurt', async () => {
    const a = fresh(), aDir = tmp()
    const m = fill(a, 'Weekly sync', 'budget')
    mkdirSync(join(aDir, m.id), { recursive: true })
    writeFileSync(join(aDir, m.id, 'me.m4a'), 'my voice')
    mkdirSync(join(aDir, m.id, 'original'))
    writeFileSync(join(aDir, m.id, 'original', 'me-source-hash.m4a'), 'retained full-quality voice')
    writeFileSync(join(aDir, m.id, 'them.live.f32'), 'a scratch copy')
    const out = join(tmp(), 'Yogurt backup.zip')
    expect(await exportBackup({ db: a.db, meetingsDir: aDir, out, appVersion: '1.2.3', now: 42 })).toEqual({ meetings: 1 })

    const look = tmp()
    await unpack(out, look)
    expect(JSON.parse(readFileSync(join(look, 'manifest.json'), 'utf8'))).toEqual({ format: BACKUP_FORMAT, app: '1.2.3', createdAt: 42, meetings: 1 })
    expect(existsSync(join(look, 'yogurt.db'))).toBe(true)
    expect(readFileSync(join(look, 'meetings', m.id, 'me.m4a'), 'utf8')).toBe('my voice')
    expect(existsSync(join(look, 'meetings', m.id, 'them.live.f32'))).toBe(false)

    const b = fresh(), bDir = tmp()
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: out })).toEqual({ ok: true, added: 1, skipped: 0 })
    expect(b.meeting(m.id)?.title).toBe('Weekly sync')
    expect(readFileSync(join(bDir, m.id, 'me.m4a'), 'utf8')).toBe('my voice')
    expect(readFileSync(join(bDir, m.id, 'original', 'me-source-hash.m4a'), 'utf8')).toBe('retained full-quality voice')
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: out })).toEqual({ ok: true, added: 0, skipped: 1 })
  })

  // a Mac zips with ditto and Windows and Linux with packPortable: each restores the other's, Opus and AAC recordings alike
  it.each([
    ['made on Windows or Linux', () => vi.mocked(pack).mockImplementationOnce(packPortable)],
    ['made on a Mac, restored on Windows or Linux', () => vi.mocked(unpack).mockImplementationOnce(unpackPortable)],
  ])('restores a backup %s, with every recording', async (_where, cross) => {
    const a = fresh(), aDir = tmp()
    const m = fill(a, 'Équipe 会議', 'budget')
    mkdirSync(join(aDir, m.id), { recursive: true })
    writeFileSync(join(aDir, m.id, 'me.ogg'), 'opus voice')
    writeFileSync(join(aDir, m.id, 'them.1.ogg'), 'opus part')
    writeFileSync(join(aDir, m.id, 'them.m4a'), 'aac voice')
    cross()
    const out = join(tmp(), 'Yogurt backup.zip')
    await exportBackup({ db: a.db, meetingsDir: aDir, out, appVersion: '1', now: 1 })
    const b = fresh(), bDir = tmp()
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: out })).toEqual({ ok: true, added: 1, skipped: 0 })
    expect(b.meeting(m.id)?.title).toBe('Équipe 会議')
    expect(readdirSync(join(bDir, m.id)).sort()).toEqual(['me.ogg', 'them.1.ogg', 'them.m4a'])
    expect(readFileSync(join(bDir, m.id, 'me.ogg'), 'utf8')).toBe('opus voice')
  })

  it('leaves meetings in the Trash out of a backup, their rows and their recordings', async () => {
    const a = fresh(), aDir = tmp()
    const keep = fill(a, 'Weekly sync', 'budget')
    const gone = fill(a, 'Old sync', 'mango')
    const f = a.createFolder('Team')
    a.addToFolder(f.id, keep.id); a.addToFolder(f.id, gone.id)
    for (const m of [keep, gone]) { mkdirSync(join(aDir, m.id), { recursive: true }); writeFileSync(join(aDir, m.id, 'me.m4a'), 'voice') }
    a.trashMeeting(gone.id, 5)
    const out = join(tmp(), 'Yogurt backup.zip')
    expect(await exportBackup({ db: a.db, meetingsDir: aDir, out, appVersion: '1', now: 1 })).toEqual({ meetings: 1 })
    const look = tmp()
    await unpack(out, look)
    expect(existsSync(join(look, 'meetings', gone.id))).toBe(false)
    const b = fresh(), bDir = tmp()
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: out })).toEqual({ ok: true, added: 1, skipped: 0 })
    expect(b.meeting(gone.id)).toBeUndefined()
    expect(b.search('mango', 10)).toEqual([])
    expect(b.folders()[0].count).toBe(1)
    // the one still here keeps its place in the Trash
    expect(a.meeting(gone.id)?.trashedAt).toBe(5)
  })

  it('refuses a backup from a newer Yogurt and anything that is not a backup, adding nothing', async () => {
    const b = fresh(), bDir = tmp()
    const src = tmp()
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ format: BACKUP_FORMAT + 1, app: '9.0.0', createdAt: 1, meetings: 0 }))
    const newer = join(tmp(), 'newer.zip')
    await pack(src, newer)
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: newer })).toEqual({ ok: false, error: 'newer' })
    writeFileSync(join(src, 'manifest.json'), '{broken json')
    const junk = join(tmp(), 'junk.zip')
    await pack(src, junk)
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip: junk })).toEqual({ ok: false, error: 'invalid' })
  })

  it.each(['missing manifest', 'missing meeting table'])('identifies a proven invalid archive: %s', async (reason) => {
    const b = fresh(), src = tmp(), zip = join(tmp(), 'invalid.zip')
    const db = new DatabaseSync(join(src, 'yogurt.db'))
    db.exec('CREATE TABLE unrelated (value TEXT)')
    db.close()
    if (reason !== 'missing manifest') writeFileSync(join(src, 'manifest.json'), JSON.stringify({ format: BACKUP_FORMAT }))
    await pack(src, zip)
    expect(await importBackup({ db: b.db, meetingsDir: tmp(), zip })).toEqual({ ok: false, error: 'invalid' })
    expect(b.meetings({ limit: 10 })).toEqual([])
  })

  it.each([false, true])('reports a failed row import even when recording rollback cleanup fails: %s', async (cleanupFails) => {
    const b = fresh(), bDir = tmp()
    const src = tmp()
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ format: BACKUP_FORMAT, app: '1.0.0', createdAt: 1, meetings: 1 }))
    const bad = new DatabaseSync(join(src, 'yogurt.db'))
    bad.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER, attendees TEXT, state TEXT);
      CREATE TABLE segments (id INTEGER PRIMARY KEY, meeting_id TEXT, track TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT);
      INSERT INTO meetings VALUES ('m2', 'Broken', 2, '[]', 'done');
      INSERT INTO segments VALUES (2, 'm2', 'me', 0, 1, NULL);`)
    bad.close()
    mkdirSync(join(src, 'meetings', 'm2'), { recursive: true })
    writeFileSync(join(src, 'meetings', 'm2', 'me.m4a'), 'x')
    const zip = join(tmp(), 'bad.zip')
    await pack(src, zip)
    if (cleanupFails) vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'))
    expect(await importBackup({ db: b.db, meetingsDir: bDir, zip })).toEqual({ ok: false, error: 'failed' })
    expect(existsSync(join(bDir, 'm2'))).toBe(cleanupFails)
    expect(b.meeting('m2')).toBeUndefined()
  })
})
