import { afterEach, expect, it } from 'vitest'
import { openStore } from '../src/main/store'
import { backfillPeople } from '../src/main/people'
import { attendeeMembership, attendeePrivacy, resolvedPersonName } from '../src/shared/people'
import { toMarkdownFile } from '../src/shared/exportNotes'
const stores: ReturnType<typeof openStore>[] = []
afterEach(() => stores.splice(0).forEach(s => s.close()))
const fresh = () => { const s = openStore(':memory:'); stores.push(s); return s }
const create = (s: ReturnType<typeof fresh>, email: string | null = 'Jamie@Northwind.example') => s.createMeeting({ title: 'Call', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [{ name: 'jamie', email }], state: 'done' })
it('resolves an override, best observed name, then a capitalized local part', () => {
  expect(resolvedPersonName('jamie@northwind.example', 'Jamie Quill', ['Jamie Jones'])).toBe('Jamie Quill')
  expect(resolvedPersonName('jamie@northwind.example', null, ['jamie', 'Jamie Quill', 'Jamie'])).toBe('Jamie Quill')
  expect(resolvedPersonName('jamie@northwind.example', null, ['jamie'])).toBe('Jamie')
  expect(resolvedPersonName('maya.chen@x.com', null, [])).toBe('Maya chen')
})
it('backfills idempotently and propagates a rename across meetings and exports without changing membership', () => {
  const s = fresh(), a = create(s), b = create(s, 'jamie@northwind.example')
  s.db.exec('DELETE FROM people')
  backfillPeople(s.db); const before = s.db.prepare('SELECT * FROM people').all()
  backfillPeople(s.db); expect(s.db.prepare('SELECT * FROM people').all()).toEqual(before)
  const stamp = attendeeMembership(s.meeting(a.id)!.attendees)
  s.setNotes(a.id, { enhanced: 'Summary' })
  s.setWrittenWith(a.id, stamp)
  expect(s.renameAttendee(a.id, 0, 'Jamie Quill')).toBe(true)
  backfillPeople(s.db)
  expect(s.meeting(b.id)!.attendees).toEqual([{ name: 'Jamie Quill', email: 'jamie@northwind.example' }])
  expect(s.meetingCards({ limit: 10 }).every(m => m.attendees[0].name === 'Jamie Quill')).toBe(true)
  expect(toMarkdownFile(s.meeting(b.id)!, '', [])).toContain('Jamie Quill')
  expect(attendeeMembership(s.meeting(a.id)!.attendees)).toBe(stamp)
  expect(s.writtenWith(a.id)).toBe(stamp)
})
it('renames a name-only attendee on just that meeting, preserving the Summary membership baseline', () => {
  const s = fresh(), a = create(s, null), b = create(s, null)
  s.setNotes(a.id, { enhanced: 'Summary' })
  s.setWrittenWith(a.id, attendeeMembership(a.attendees))
  s.renameAttendee(a.id, 0, 'Jamie Quill')
  expect(s.meeting(a.id)!.attendees[0].name).toBe('Jamie Quill')
  expect(s.meeting(b.id)!.attendees[0].name).toBe('jamie')
  expect(s.writtenWith(a.id)).toBe(attendeeMembership(s.meeting(a.id)!.attendees))
})
it('shows privacy copy only while adding or when an address is being typed', () => {
  expect(attendeePrivacy(false, '')).toBe(false)
  expect(attendeePrivacy(false, 'Jamie')).toBe(false)
  expect(attendeePrivacy(true, '')).toBe(true)
  expect(attendeePrivacy(false, 'jamie@')).toBe(true)
})
it('migrates a matching old name baseline without hiding a real membership change', () => {
  const s = fresh(), a = create(s), b = create(s)
  s.setNotes(a.id, { enhanced: 'Summary' }); s.setNotes(b.id, { enhanced: 'Summary' })
  s.setWrittenWith(a.id, 'jamie'); s.setWrittenWith(b.id, 'Someone else')
  backfillPeople(s.db)
  expect(s.writtenWith(a.id)).toBe(attendeeMembership(s.meeting(a.id)!.attendees))
  expect(s.writtenWith(b.id)).toBe('Someone else')
})
it('keeps person overrides through backup import, without replacing a newer local choice', async () => {
  const { mergeBackup } = await import('../src/main/backup')
  const source = fresh(), target = fresh(), a = create(source)
  source.renameAttendee(a.id, 0, 'Jamie Quill')
  mergeBackup(target.db, source.db)
  expect(target.meeting(a.id)!.attendees[0].name).toBe('Jamie Quill')
  target.renameAttendee(a.id, 0, 'Jamie Local')
  mergeBackup(target.db, source.db)
  expect(target.meeting(a.id)!.attendees[0].name).toBe('Jamie Local')
})
