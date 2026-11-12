import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { genericTitle, setGenericTitles } from '../src/main/titles'
import { openStore, type Store } from '../src/main/store'
import { initMeetings, renameMeeting, startMeeting, stopMeeting } from '../src/main/meeting'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { endedAt: null, eventId: null, app: null, attendees: [], state: 'done' as const, startedAt: 1 }

describe('genericTitle', () => {
  it('the titles Yogurt gives a meeting with no event are generic', () => {
    for (const t of ['Meeting', 'Zoom call', 'zoom.us call', 'Microsoft Teams call', 'Google Meet', 'Teams meeting', 'Zoom meeting', 'Untitled', 'New note', '  meeting ', 'FaceTime call', 'Slack call']) expect(genericTitle(t)).toBe(true)
  })
  it("the interface language's own words, given by the app, are generic too", () => {
    setGenericTitles({ meeting: 'Reunión', appCall: 'Llamada de \u0000' })
    try {
      expect(genericTitle('Reunión')).toBe(true)
      expect(genericTitle('Llamada de Zoom')).toBe(true)
      expect(genericTitle('Llamada con el banco')).toBe(false)
    } finally { setGenericTitles({ meeting: 'Meeting', appCall: '\u0000 call' }) }
  })
  it('titles.ts loads without the locale tables', async () => {
    const src = (await import('node:fs')).readFileSync(join(__dirname, '../src/main/titles.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"][^'"]*i18n/)
  })
  it('a real title is not', () => {
    for (const t of ['Testing Yogurt transcription accuracy with Dana', 'Weekly sync', 'Call with the bank about the loan', 'Design review', 'Long meeting about pricing', '']) expect(genericTitle(t)).toBe(t === '')
  })
})

describe('where a title came from', () => {
  it('a meeting started from an event has a calendar title; one without, a generic one; a rename makes it theirs', () => {
    const store = openStore(':memory:'); stores.push(store); initMeetings(store)
    const event = { id: 'e1', title: 'Design review', start: 1, end: 2, attendees: [], url: null }
    const a = startMeeting({ title: 'Design review', event, app: 'Zoom' })
    expect(store.meeting(a.id)!.titleSource).toBe('calendar')
    stopMeeting(a.id)
    const b = startMeeting({ title: 'Zoom call', event: null, app: 'Zoom' })
    expect(store.meeting(b.id)!.titleSource).toBe('generic')
    renameMeeting(b.id, 'Budget review')
    expect(store.meeting(b.id)).toMatchObject({ title: 'Budget review', titleSource: 'user' })
    stopMeeting(b.id)
    // an event with no title of its own gets the generic one
    const c = startMeeting({ title: '', event: { ...event, id: 'e2', title: '' }, app: null })
    expect(store.meeting(c.id)).toMatchObject({ title: 'Meeting', titleSource: 'generic' })
  })
  it("createMeeting works it out when not told: a generic title is generic, an event's calendar, anything else theirs", () => {
    const store = openStore(':memory:'); stores.push(store)
    expect(store.createMeeting({ ...base, title: 'Sync', eventId: 'e' }).titleSource).toBe('calendar')
    expect(store.createMeeting({ ...base, title: 'Zoom call' }).titleSource).toBe('generic')
    expect(store.createMeeting({ ...base, title: 'Sync' }).titleSource).toBe('user')
    expect(store.createMeeting({ ...base, title: 'Meeting', eventId: 'e' }).titleSource).toBe('generic')
    const m = store.createMeeting({ ...base, title: 'Zoom call' })
    store.updateMeeting(m.id, { title: 'Pricing with Dana', titleSource: 'auto' })
    expect(store.meeting(m.id)).toMatchObject({ title: 'Pricing with Dana', titleSource: 'auto' })
  })
  it("a database from before titles had a source gets one: generic titles generic (even an event's), other events calendar, the rest theirs", () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-titles-')); dirs.push(d)
    const file = join(d, 'yogurt.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, event_id TEXT, app TEXT, attendees TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, language TEXT);
      INSERT INTO meetings (id, title, started_at, event_id, state) VALUES ('a', 'Design review', 1, 'e1', 'done'), ('b', 'Zoom call', 2, NULL, 'done'), ('c', 'Budget review', 3, NULL, 'done'), ('d', 'Meeting', 4, 'e2', 'done')`)
    old.close()
    const s = openStore(file); stores.push(s)
    expect(['a', 'b', 'c', 'd'].map((id) => s.meeting(id)!.titleSource)).toEqual(['calendar', 'generic', 'user', 'generic'])
  })
})
