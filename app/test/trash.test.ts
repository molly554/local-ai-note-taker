import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { TRASH_DAYS, trashCutoff } from '../src/shared/trash'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-trash-'))
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

describe('the Trash', () => {
  it('a meeting moved to the Trash is kept, but out of Meetings, folders, search and the calendar', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'Pineapple review', startedAt: 1000, eventId: 'ev-1' })
    const b = s.createMeeting({ ...base, title: 'Pineapple plan', startedAt: 2000 })
    s.addSegments([{ meetingId: a.id, track: 'them', startMs: 0, endMs: 900, text: 'the mango budget', speaker: null }])
    s.setNotes(a.id, { mine: 'kiwi', enhanced: '## Kiwi' })
    const f = s.createFolder('Fruit')
    s.addToFolder(f.id, a.id); s.addToFolder(f.id, b.id)

    s.trashMeeting(a.id, 5000)

    expect(s.meeting(a.id)).toMatchObject({ id: a.id, trashedAt: 5000 })
    expect(s.meetings({ limit: 10 }).map((m) => m.id)).toEqual([b.id])
    expect(s.meetingCards({ limit: 10 }).map((m) => m.id)).toEqual([b.id])
    expect(s.meetingCards({ limit: 10, folder: f.id }).map((m) => m.id)).toEqual([b.id])
    expect(s.folder(f.id)?.count).toBe(1)
    expect(s.folders()[0].count).toBe(1)
    expect(s.folderMeetingIds(f.id)).toEqual([b.id])
    expect(s.search('pineapple', 10).map((h) => h.meetingId)).toEqual([b.id])
    expect(s.search('mango', 10)).toEqual([])
    expect(s.search('kiwi', 10)).toEqual([])
    expect(s.search('mango', 10, f.id)).toEqual([])
    expect(s.meetingForEvent('ev-1')).toBeUndefined()
    // its things are all still there for a restore
    expect(s.segments(a.id)).toHaveLength(1)
    expect(s.notes(a.id).mine).toBe('kiwi')
  })

  it('lists what is in the Trash, last moved there first, with a preview', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'A', startedAt: 1000 })
    const b = s.createMeeting({ ...base, title: 'B', startedAt: 2000 })
    s.createMeeting({ ...base, title: 'C', startedAt: 3000 })
    s.setNotes(a.id, { mine: 'first words' })
    s.trashMeeting(a.id, 9000)
    s.trashMeeting(b.id, 8000)
    expect(s.trashed().map((m) => [m.title, m.trashedAt])).toEqual([['A', 9000], ['B', 8000]])
    expect(s.trashed()[0].preview).toBe('first words')
  })

  it('restore puts it back where it was, in its folders and in search', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'Pineapple review', startedAt: 1000, eventId: 'ev-1' })
    const f = s.createFolder('Fruit')
    s.addToFolder(f.id, a.id)
    s.trashMeeting(a.id, 5000)
    s.restoreMeeting(a.id)
    expect(s.meeting(a.id)?.trashedAt).toBeUndefined()
    expect(s.trashed()).toEqual([])
    expect(s.meetingCards({ limit: 10, folder: f.id }).map((m) => m.id)).toEqual([a.id])
    expect(s.folder(f.id)?.count).toBe(1)
    expect(s.search('pineapple', 10).map((h) => h.meetingId)).toEqual([a.id])
    expect(s.meetingForEvent('ev-1')?.id).toBe(a.id)
  })

  it('a recording meeting never goes to the Trash', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'Live', startedAt: 1000, state: 'recording' })
    expect(s.trashMeeting(a.id, 5000)).toBe(false)
    expect(s.meeting(a.id)?.trashedAt).toBeUndefined()
  })

  it('finds what has been in the Trash longer than 30 days', () => {
    const s = fresh()
    const day = 24 * 60 * 60 * 1000
    const now = 100 * day
    const old = s.createMeeting({ ...base, title: 'Old', startedAt: 1 })
    const recent = s.createMeeting({ ...base, title: 'Recent', startedAt: 2 })
    s.createMeeting({ ...base, title: 'Kept', startedAt: 3 })
    s.trashMeeting(old.id, now - 31 * day)
    s.trashMeeting(recent.id, now - 29 * day)
    expect(TRASH_DAYS).toBe(30)
    expect(s.trashedBefore(trashCutoff(now))).toEqual([old.id])
  })

  it('chat across meetings leaves trashed meetings out: nothing to index, nothing to search', () => {
    const s = fresh()
    const lib = new Library(s.db)
    const a = s.createMeeting({ ...base, title: 'Gone', startedAt: 1000 })
    const b = s.createMeeting({ ...base, title: 'Here', startedAt: 2000 })
    lib.setChunks(a.id, 'x', [], [{ startMs: 0, endMs: 1, text: 'gone words', speakers: [] }])
    s.trashMeeting(a.id, 5000)
    expect(lib.stale().map((x) => x.meetingId)).toEqual([b.id])
    expect(lib.finished().map((m) => m.id)).toEqual([b.id])
    expect(lib.unembedded('m', 10)).toEqual([])
    s.restoreMeeting(a.id)
    expect(lib.finished().map((m) => m.id)).toEqual([b.id, a.id])
  })

  it('a database from before the Trash gets its column, and nothing in it is trashed', () => {
    const s = fresh()
    s.db.exec('ALTER TABLE meetings DROP COLUMN trashed_at')
    s.db.prepare("INSERT INTO meetings (id, title, started_at, state) VALUES ('old1', 'Old', 1, 'done')").run()
    const file = s.db.prepare('PRAGMA database_list').get() as { file: string }
    s.close(); stores.splice(stores.indexOf(s), 1)
    const again = openStore(file.file)
    stores.push(again)
    expect(again.meeting('old1')?.trashedAt).toBeUndefined()
    expect(again.meetings({ limit: 10 }).map((m) => m.id)).toEqual(['old1'])
  })
})
