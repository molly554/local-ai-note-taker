import { migrateMeetingChats } from './library/store'
import backupFormat from '../shared/backupFormat.json'
import { backfillPeople, mergePeople } from './people'
import { constants, existsSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isId } from './ipcArgs'
import { pack, unpack } from './zip'

/**
 * A backup is one zip: manifest.json, a snapshot of yogurt.db and meetings/<id>/ with each meeting's recordings.
 * Importing adds the meetings that are not here yet and never changes or removes one that is.
 */
export const BACKUP_FORMAT = backupFormat.format
export type Manifest = { format: number; app: string; createdAt: number; meetings: number }
export type ImportResult = { ok: true; added: number; skipped: number } | { ok: false; error: 'newer' | 'invalid' | 'failed' }

type Row = Record<string, string | number | bigint | null | Uint8Array>
const q = (name: string) => `"${name.replace(/"/g, '""')}"`
const tables = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => String(r.name)))
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string; type: string; pk: number }>

export function checkManifest(raw: unknown): 'ok' | 'newer' | 'invalid' {
  const f = raw && typeof raw === 'object' ? (raw as { format?: unknown }).format : undefined
  if (!Number.isInteger(f) || (f as number) < 1) return 'invalid'
  return (f as number) > BACKUP_FORMAT ? 'newer' : 'ok'
}

/**
 * The tables whose rows belong to one meeting, found from the schema (a foreign key to meetings), so a table or
 * column added later is in backups without anyone remembering to list it. test/backup.test.ts fails when a table
 * that is not tied to a meeting appears, so whoever adds one decides what a backup does with it.
 */
export function meetingTables(db: DatabaseSync): Array<{ table: string; column: string }> {
  return [...tables(db)].filter((t) => !t.startsWith('sqlite_')).flatMap((table) => {
    const fk = (db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all() as Array<{ table: string; from: string }>).find((k) => k.table === 'meetings')
    return fk ? [{ table, column: fk.from }] : []
  })
}

/**
 * Tables not tied to a meeting that a backup still carries, each with the column that says whose rows they are: the
 * chats across meetings (a conversation and its turns, library/store.ts) and folders (a meeting's place in one is in
 * folder_meetings, a meeting table). A conversation or folder is added whole when it isn't here.
 */
export function carriedTables(db: DatabaseSync): Array<{ table: string; column: string }> {
  const have = tables(db)
  return [{ table: 'conversations', column: 'id' }, { table: 'conversation_turns', column: 'conversation_id' }, { table: 'folders', column: 'id' }].filter((t) => have.has(t.table))
}

/** ids in the backup's table that are not here (and are safe as folder names) */
function newIds(into: DatabaseSync, from: DatabaseSync, table = 'meetings'): { add: string[]; skipped: number } {
  if (!tables(from).has(table) || !tables(into).has(table)) return { add: [], skipped: 0 }
  const ids = (from.prepare(`SELECT id FROM ${q(table)}`).all() as Row[]).map((r) => r.id).filter(isId)
  const here = into.prepare(`SELECT 1 FROM ${q(table)} WHERE id = ?`)
  const provenance = table === 'meetings' && [into, from].every((db) => ['source', 'source_id'].every((c) => columns(db, table).some((col) => col.name === c)))
  const source = provenance ? from.prepare('SELECT source, source_id FROM meetings WHERE id = ?') : undefined
  const imported = provenance ? into.prepare('SELECT 1 FROM meetings WHERE source = ? AND source_id = ?') : undefined
  const add = ids.filter((id) => {
    if (here.get(id)) return false
    const r = source?.get(id) as Row | undefined
    return !(r?.source != null && r.source_id != null && imported?.get(r.source, r.source_id))
  })
  return { add, skipped: ids.length - add.length }
}

/** how each table's rows of one id are read from the backup and written here, by the columns both sides have */
function plans(into: DatabaseSync, from: DatabaseSync, list: Array<{ table: string; column: string }>) {
  const theirs = tables(from)
  return list.filter((t) => theirs.has(t.table) && columns(from, t.table).some((c) => c.name === t.column)).map(({ table, column }) => {
    const mine = columns(into, table)
    const pks = mine.filter((c) => c.pk > 0)
    const ownNumber = pks.length === 1 && pks[0].type.toUpperCase() === 'INTEGER' ? pks[0].name : undefined
    const have = new Set(columns(from, table).map((c) => c.name))
    const cols = mine.map((c) => c.name).filter((c) => have.has(c) && c !== ownNumber)
    return { table, cols, read: from.prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(table)} WHERE ${q(column)} = ?`),
      write: into.prepare(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`) }
  })
}

/**
 * Copies the backup's new meetings, and every row of theirs, into this database in one transaction: all of it or none.
 * Rows go by the columns both sides have, so an older backup gets this version's defaults and a newer one's extra
 * columns are left out. A table's own number id is given out again here (the backup's may already be taken).
 * Conversations and folders that aren't here come along the same way (carriedTables); a folder already here is never changed.
 * People merge separately by email, preserving an existing local display-name override.
 */
export function mergeBackup(into: DatabaseSync, from: DatabaseSync): { added: string[]; skipped: number } {
  const { add, skipped } = newIds(into, from)
  const chats = newIds(into, from, 'conversations').add
  const folders = tables(from).has('folder_meetings') ? newIds(into, from, 'folders').add : []
  if (!add.length && !chats.length && !folders.length && !tables(from).has('people')) return { added: [], skipped }
  // a backup from when voices had letters (Speaker A, B): those lines come in as Them, as this database's own did
  const lettered = tables(from).has('speakers')
  const plan = plans(into, from, [{ table: 'meetings', column: 'id' }, ...meetingTables(into)])
  const carried = plans(into, from, carriedTables(into))
  const chatTables = carried.filter((p) => p.table !== 'folders'), folderTable = carried.filter((p) => p.table === 'folders')
  into.exec('BEGIN')
  try {
    // folders first, so the new meetings' places in them have somewhere to go
    for (const id of folders) for (const p of folderTable) for (const row of p.read.all(id) as Row[]) p.write.run(...p.cols.map((c) => row[c]))
    for (const id of add) {
      for (const p of plan) {
        for (const row of p.read.all(id) as Row[]) {
          // a meeting that was recording when the backup was made stopped there, as after a crash
          if (p.table === 'meetings' && row.state === 'recording') row.state = 'stopped'
          if (p.table === 'segments' && lettered && row.track === 'them') row.speaker = null
          const r = p.write.run(...p.cols.map((c) => row[c]))
          // the insert trigger puts every line in search; hidden echo lines come out again, as addSegments does
          if (p.table === 'segments') {
            const s = into.prepare('SELECT hidden, text FROM segments WHERE rowid = ?').get(r.lastInsertRowid) as Row | undefined
            if (s && Number(s.hidden) === 1) into.prepare("INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', ?, ?)").run(r.lastInsertRowid, s.text)
          }
        }
      }
    }
    for (const id of chats) for (const p of chatTables) for (const row of p.read.all(id) as Row[]) p.write.run(...p.cols.map((c) => row[c]))
    // a folder new here holds every meeting it held in the backup, meetings already here too (nothing of theirs changes)
    const link = into.prepare('INSERT OR IGNORE INTO folder_meetings (folder_id, meeting_id, added_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM meetings WHERE id = ?)')
    for (const fid of folders) {
      for (const r of from.prepare('SELECT meeting_id, added_at FROM folder_meetings WHERE folder_id = ?').all(fid) as Row[]) link.run(fid, r.meeting_id, r.added_at, r.meeting_id)
    }
    migrateMeetingChats(into)
    mergePeople(into, from)
    backfillPeople(into)
    into.exec('COMMIT')
  } catch (e) { into.exec('ROLLBACK'); throw e }
  return { added: add, skipped }
}

/** the live copy older versions kept for telling voices apart: scratch, not a recording */
const scratch = (name: string) => name.endsWith('.f32')
// Cleanup cannot undo a committed export/import or replace the original failure.
const cleanup = (dir: string) => rm(dir, { recursive: true, force: true }).catch((e) => console.warn('backup cleanup failed', dir, e))

/** Everything to one zip: a snapshot of the database (safe while Yogurt runs), each meeting's recordings, and a manifest */
export async function exportBackup(o: { db: DatabaseSync; meetingsDir: string; out: string; appVersion: string; now?: number }): Promise<{ meetings: number }> {
  const work = await mkdtemp(join(tmpdir(), 'yogurt-export-'))
  let staging: string | undefined
  try {
    const file = join(work, 'yogurt.db')
    o.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
    const snap = new DatabaseSync(file)
    // meetings in the Trash are on their way out: not in the backup (their rows go with them by ON DELETE CASCADE)
    snap.exec('PRAGMA foreign_keys = ON')
    // and VACUUM so their words aren't left in the file's free pages
    if (columns(snap, 'meetings').some((c) => c.name === 'trashed_at') && Number(snap.prepare('DELETE FROM meetings WHERE trashed_at IS NOT NULL').run().changes) > 0) snap.exec('VACUUM')
    const ids = (snap.prepare('SELECT id FROM meetings').all() as Row[]).map((r) => r.id).filter(isId)
    snap.close()
    for (const id of ids) {
      const src = join(o.meetingsDir, id)
      if (!existsSync(src)) continue
      // a clone on the Mac's disk: instant, and no extra space until one side changes
      await cp(src, join(work, 'meetings', id), { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (s) => !scratch(s) })
    }
    const manifest: Manifest = { format: BACKUP_FORMAT, app: o.appVersion, createdAt: o.now ?? Date.now(), meetings: ids.length }
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2))
    // Keep the previous backup until its replacement is complete. Stage beside the
    // destination so the final rename stays atomic, including on an external disk.
    staging = await mkdtemp(join(dirname(o.out), '.yogurt-backup-'))
    const archive = join(staging, 'backup.zip')
    await pack(work, archive)
    await rename(archive, o.out)
    return { meetings: ids.length }
  } finally {
    await Promise.all([
      cleanup(work),
      staging ? cleanup(staging) : Promise.resolve(),
    ])
  }
}

/** only plain files and folders come out of a backup: a link could point anywhere on the computer */
const plainOnly = async (s: string) => !(await lstat(s)).isSymbolicLink()

/** Adds missing meetings, recordings first. A failed merge rolls back rows and attempts to remove its copied audio. */
export async function importBackup(o: { db: DatabaseSync; meetingsDir: string; zip: string }): Promise<ImportResult> {
  let work: string | undefined
  const copied: string[] = []
  let from: DatabaseSync | undefined
  try {
    work = await mkdtemp(join(tmpdir(), 'yogurt-import-'))
    // Extraction can fail for disk or permission errors; that does not prove the archive is invalid.
    await unpack(o.zip, work)
    let manifest: string
    try {
      manifest = await readFile(join(work, 'manifest.json'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'invalid' }
      throw e
    }
    let raw: unknown
    try { raw = JSON.parse(manifest) } catch { return { ok: false, error: 'invalid' } }
    const ok = checkManifest(raw)
    if (ok !== 'ok') return { ok: false, error: ok }
    from = new DatabaseSync(join(work, 'yogurt.db'), { readOnly: true })
    if (!tables(from).has('meetings') || !columns(from, 'meetings').some((c) => c.name === 'id')) return { ok: false, error: 'invalid' }
    for (const id of newIds(o.db, from).add) {
      const src = join(work, 'meetings', id), dest = join(o.meetingsDir, id)
      if (!existsSync(src) || existsSync(dest)) continue
      await mkdir(o.meetingsDir, { recursive: true })
      copied.push(dest)
      await cp(src, dest, { recursive: true, filter: plainOnly })
    }
    const r = mergeBackup(o.db, from)
    return { ok: true, added: r.added.length, skipped: r.skipped }
  } catch (e) {
    console.error('import failed', e)
    for (const d of copied) await cleanup(d)
    return { ok: false, error: 'failed' }
  } finally {
    try { from?.close() } catch (e) { console.warn('backup database close failed', e) }
    if (work) await cleanup(work)
  }
}
