import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { DatabaseSync } from 'node:sqlite'
import { mergeBackup } from '../src/main/backup'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-folders-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { endedAt: 2000, eventId: null, app: null, attendees: [], state: 'done' as const }
const meeting = (s: Store, title: string, startedAt: number) => s.createMeeting({ ...base, title, startedAt })

describe('folders', () => {
  it('persists a chosen order, keeps it after rename, and appends new folders', () => {
    const s = fresh(), a = s.createFolder('Alpha'), b = s.createFolder('Beta'), c = s.createFolder('Gamma')
    expect(s.reorderFolders([c.id, a.id, b.id])).toBe(true)
    s.renameFolder(c.id, 'Zeta')
    const d = s.createFolder('A new folder')
    const file = String((s.db.prepare('PRAGMA database_list').get() as { file: string }).file)
    const reopened = openStore(file); stores.push(reopened)
    expect(reopened.folders().map(f => f.id)).toEqual([c.id, a.id, b.id, d.id])
    expect(reopened.reorderFolders([a.id, a.id, b.id, d.id])).toBe(false)
    expect(reopened.reorderFolders([a.id, b.id])).toBe(false)
    expect(reopened.reorderFolders([a.id, b.id, c.id, 'missing'])).toBe(false)
    expect(reopened.folders().map(f => f.id)).toEqual([c.id, a.id, b.id, d.id])
  })

  it('creates, renames and lists folders by name, with how many meetings each holds', () => {
    const s = fresh()
    const b = s.createFolder('  Sales  ')
    const a = s.createFolder('Design')
    expect(b).toMatchObject({ name: 'Sales', count: 0 })
    expect(s.folders().map((x) => x.name)).toEqual(['Design', 'Sales'])
    s.renameFolder(a.id, 'Zebra work')
    expect(s.folders().map((x) => x.name)).toEqual(['Sales', 'Zebra work'])
    expect(s.folder(a.id)?.name).toBe('Zebra work')
    // a blank name keeps the old one
    s.renameFolder(a.id, '   ')
    expect(s.folder(a.id)?.name).toBe('Zebra work')
    expect(s.folder('nope')).toBeUndefined()
  })

  it('keeps a folder appearance across reopening and supplies every membership to meeting cards', () => {
    const s = fresh(), m = meeting(s, 'Kickoff', 1000)
    expect(s.meetingCards({ limit: 10 })[0].folders).toEqual([])
    const a = s.createFolder('Design', { icon: 'palette', color: 'violet' })
    const b = s.createFolder('Product', { icon: 'rocket', color: 'blue' })
    s.addToFolder(a.id, m.id)
    const membership = { id: a.id, name: 'Design', icon: 'palette', color: 'violet' }
    expect(s.meetingCards({ limit: 10 })[0].folders).toEqual([membership])
    s.addToFolder(b.id, m.id)
    expect(s.meetingCards({ limit: 10 })[0].folders).toEqual([membership, { id: b.id, name: 'Product', icon: 'rocket', color: 'blue' }])
    expect(s.meetingCards({ limit: 10, folder: a.id })[0].folders?.map(f => f.id)).toEqual([a.id, b.id])
    s.setFolderAppearance(a.id, { icon: 'star', color: 'amber' })
    const file = String((s.db.prepare('PRAGMA database_list').get() as { file: string }).file)
    const reopened = openStore(file); stores.push(reopened)
    expect(reopened.folder(a.id)).toMatchObject({ icon: 'star', color: 'amber', count: 1 })
    expect(reopened.foldersOf(m.id)[0]).toMatchObject({ icon: 'star', color: 'amber' })
    s.deleteFolder(b.id)
    expect(s.meetingCards({ limit: 10 })[0].folders).toEqual([{ ...membership, icon: 'star', color: 'amber' }])
  })

  it('migrates old folders without changing names and safely reads unknown appearances', () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-folder-migration-')); dirs.push(d)
    const file = join(d, 'yogurt.db'), old = new DatabaseSync(file)
    old.exec("CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO folders VALUES ('old', 'Design', 42)")
    old.close()
    const s = openStore(file); stores.push(s)
    expect(s.folder('old')).toEqual({ id: 'old', name: 'Design', createdAt: 42, count: 0, icon: 'folder', color: 'default' })
    s.db.exec("UPDATE folders SET icon = '<svg>', color = 'url(evil)' WHERE id = 'old'")
    expect(s.folder('old')).toMatchObject({ icon: 'folder', color: 'default' })
  })

  it('a meeting can be in several folders, and once in each', () => {
    const s = fresh()
    const m = meeting(s, 'Kickoff', 1000)
    const a = s.createFolder('Acme'), b = s.createFolder('Board')
    s.addToFolder(a.id, m.id); s.addToFolder(a.id, m.id); s.addToFolder(b.id, m.id)
    expect(s.foldersOf(m.id).map((x) => x.name)).toEqual(['Acme', 'Board'])
    expect(s.folders().map((x) => x.count)).toEqual([1, 1])
    s.removeFromFolder(a.id, m.id)
    expect(s.foldersOf(m.id).map((x) => x.name)).toEqual(['Board'])
  })

  it('gives the meetings in a folder newest first, as ids for Chat and as cards for its page', () => {
    const s = fresh()
    const old = meeting(s, 'Old', 1000), mid = meeting(s, 'Mid', 2000), out = meeting(s, 'Elsewhere', 3000), last = meeting(s, 'New', 4000)
    const sp = s.createFolder('Acme')
    for (const m of [old, last, mid]) s.addToFolder(sp.id, m.id)
    expect(s.folderMeetingIds(sp.id)).toEqual([last.id, mid.id, old.id])
    expect(s.meetingCards({ limit: 10, folder: sp.id }).map((c) => c.title)).toEqual(['New', 'Mid', 'Old'])
    expect(s.meetingCards({ limit: 1, folder: sp.id, before: { at: 4000, id: last.id } }).map((c) => c.title)).toEqual(['Mid'])
    expect(s.meetingCards({ limit: 10 }).map((c) => c.id)).toContain(out.id)
  })

  it('deleting a folder keeps its meetings; deleting a meeting takes it out of its folders', () => {
    const s = fresh()
    const m = meeting(s, 'Kickoff', 1000), n = meeting(s, 'Review', 2000)
    const a = s.createFolder('Acme'), b = s.createFolder('Board')
    s.addToFolder(a.id, m.id); s.addToFolder(b.id, m.id); s.addToFolder(b.id, n.id)
    s.deleteFolder(a.id)
    expect(s.folders().map((x) => x.name)).toEqual(['Board'])
    expect(s.meeting(m.id)).toBeDefined()
    expect(s.foldersOf(m.id).map((x) => x.name)).toEqual(['Board'])
    s.deleteMeeting(m.id)
    expect(s.folderMeetingIds(b.id)).toEqual([n.id])
    expect(s.folders()[0].count).toBe(1)
  })

  it('search can be narrowed to a folder', () => {
    const s = fresh()
    const a = meeting(s, 'Pricing call', 1000), b = meeting(s, 'Pricing review', 2000)
    s.setNotes(a.id, { mine: 'the budget for pricing' })
    s.setNotes(b.id, { mine: 'the budget again' })
    const sp = s.createFolder('Acme')
    s.addToFolder(sp.id, a.id)
    expect(s.search('pricing', 10).map((h) => h.meetingId).sort()).toEqual([a.id, b.id].sort())
    expect(s.search('pricing', 10, sp.id).map((h) => h.meetingId)).toEqual([a.id])
    expect(s.search('budget', 10, sp.id).map((h) => h.meetingId)).toEqual([a.id])
  })
})

describe('folders in backups', () => {
  it('brings folders with the meetings, and never changes a folder or meeting already here', () => {
    const from = fresh(), into = fresh()
    const kept = meeting(from, 'Here already', 1000), added = meeting(from, 'New one', 2000)
    const acme = from.createFolder('Acme', { icon: 'rocket', color: 'violet' }), board = from.createFolder('Board', { icon: 'star', color: 'blue' })
    from.addToFolder(acme.id, kept.id); from.addToFolder(acme.id, added.id); from.addToFolder(board.id, added.id)
    // the same meeting and the same folder are already here, the person renamed the folder and took the meeting out
    into.db.prepare('INSERT INTO meetings (id, title, started_at, attendees, state) VALUES (?, ?, ?, ?, ?)').run(kept.id, 'Here already', 1000, '[]', 'done')
    into.db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(board.id, 'Board (mine)', 1)
    into.addToFolder(board.id, kept.id); into.removeFromFolder(board.id, kept.id)

    mergeBackup(into.db, from.db)
    expect(into.folders().map((x) => [x.name, x.icon, x.color])).toEqual([['Acme', 'rocket', 'violet'], ['Board (mine)', 'folder', 'default']])
    // a folder that is new here gets every meeting the backup had in it, ones already here too
    expect(into.folderMeetingIds(acme.id)).toEqual([added.id, kept.id])
    // a new meeting joins the folders it was in
    expect(into.folderMeetingIds(board.id)).toEqual([added.id])
    // twice changes nothing
    mergeBackup(into.db, from.db)
    expect(into.folders().map((x) => [x.name, x.count])).toEqual([['Acme', 2], ['Board (mine)', 1]])
  })

  it('imports folders from before appearance choices with the original default', () => {
    const from = fresh(), into = fresh(), folder = from.createFolder('Old folder')
    from.db.exec('ALTER TABLE folders DROP COLUMN icon; ALTER TABLE folders DROP COLUMN color')
    mergeBackup(into.db, from.db)
    expect(into.folder(folder.id)).toMatchObject({ name: 'Old folder', icon: 'folder', color: 'default' })
  })

  it('a backup from before folders still comes in', () => {
    const from = fresh(), into = fresh()
    const m = meeting(from, 'Old', 1000)
    from.db.exec('DROP TABLE folder_meetings; DROP TABLE folders')
    expect(mergeBackup(into.db, from.db)).toEqual({ added: [m.id], skipped: 0 })
    expect(into.folders()).toEqual([])
  })
})

it('keeps folder suggestions across reopening and does not resurrect dismissed or accepted proposals', () => {
  const s = fresh(), m = meeting(s, 'Follow-up', 10), f = s.createFolder('Customers')
  s.saveFolderSuggestion(m.id, { folderId: f.id, confidence: 0.9 }, 'folders-v1')
  const path = String(s.db.prepare('PRAGMA database_list').get()!.file)
  const reopened = openStore(path); stores.push(reopened)
  expect(reopened.folderSuggestion(m.id)).toEqual({ folderId: f.id, confidence: 0.9, state: 'pending', attempted: 'folders-v1' })
  reopened.dismissFolderSuggestion(m.id)
  s.saveFolderSuggestion(m.id, { folderId: f.id, confidence: 1 }, 'folders-v2')
  expect(s.folderSuggestion(m.id).state).toBe('dismissed')
})
