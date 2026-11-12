import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calendars, calendarStatus, meetingLink, parseEvents, refreshCalendarStatus, requestCalendarAccess, setCalendarSelection, setCalendarSupported, setHelper, upcoming } from '../src/main/calendar'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/helper-events.json'), 'utf8'))

describe('parseEvents', () => {
  it('turns the helper JSON into events with times in ms, people and a meeting link', () => {
    const ev = parseEvents(fixture)
    expect(ev).toHaveLength(3)
    expect(ev[0]).toEqual({
      id: 'E1:2026-10-29T15:00:00Z', title: 'Design review',
      start: Date.parse('2026-10-29T15:00:00Z'), end: Date.parse('2026-10-29T15:30:00Z'),
      attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo', email: null }],
      url: 'https://zoom.us/j/123456789?pwd=abc',
    })
    expect(ev[1].url).toBeNull()
    expect(ev[1].attendees).toEqual([])
    expect(ev[2].url).toBe('https://teams.microsoft.com/l/meetup-join/abc')
  })
  it('keeps a meeting shared onto two calendars once (the Mac gives it twice, same id)', () => {
    const row = (calendar: string) => ({ id: 'E9:2026-11-02T18:00:00Z', title: 'Standup', start: '2026-11-02T18:00:00Z', end: '2026-11-02T18:30:00Z', calendar })
    const ev = parseEvents([row('Dana'), row('Mine'), { ...row('Mine'), id: 'E10:2026-11-02T18:00:00Z' }])
    expect(ev.map((e) => e.id)).toEqual(['E9:2026-11-02T18:00:00Z', 'E10:2026-11-02T18:00:00Z'])
  })
  it('skips rows it cannot read', () => {
    expect(parseEvents([{ title: 'x' }, null, 'no'])).toEqual([])
    expect(parseEvents({ not: 'a list' })).toEqual([])
  })
  it('combines copies by server identity and occurrence, never by title or time alone', () => {
    const row = { id: 'work-copy', externalId: 'pool-series', title: 'Lap Swim', start: '2026-11-03T17:00:00Z', end: '2026-11-03T19:00:00Z', calendarId: 'work', calendar: 'Work' }
    const ev = parseEvents([row, { ...row, id: 'personal-copy', calendarId: 'personal' },
      { ...row, id: 'next-slot', start: '2026-11-03T19:00:00Z', end: '2026-11-03T20:30:00Z' },
      { ...row, id: 'unrelated', externalId: 'other-event' }])
    expect(ev).toHaveLength(3)
    expect(ev[0].aliases).toContain('personal-copy')
    expect(ev.map((e) => e.id)).toContain('next-slot')
    expect(ev.map((e) => e.id)).toContain('unrelated')
  })
  it('hides excluded calendars but keeps aliases so existing notes remain linked', () => {
    const row = { id: 'hidden-copy', externalId: 'same-event', title: 'Standup', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z', calendarId: 'personal', calendar: 'Personal' }
    const ev = parseEvents([row, { ...row, id: 'shown-copy', calendarId: 'work', calendar: 'Work' }], ['personal'])
    expect(ev).toHaveLength(1)
    expect(ev[0].id).toBe('shown-copy')
    expect(ev[0].aliases).toContain('hidden-copy')
    expect(ev[0].calendar).toMatchObject({ id: 'work', name: 'Work' })
    expect(parseEvents([row], ['personal'])).toEqual([])
    expect(parseEvents([row, { ...row, calendarId: 'work' }], ['personal'])).toHaveLength(1)
  })
})

describe('meetingLink', () => {
  it('finds a call link in text and ignores other links', () => {
    expect(meetingLink('Join: https://meet.google.com/abc-defg-hij thanks')).toBe('https://meet.google.com/abc-defg-hij')
    expect(meetingLink('Notes at https://docs.example.com/x')).toBeNull()
    expect(meetingLink(undefined)).toBeNull()
  })
})

describe('upcoming', () => {
  beforeEach(() => setHelper(async () => { throw new Error('no helper') }))
  afterEach(() => setCalendarSelection(() => []))

  it('reads source calendars only with permission and applies the saved selection on each read', async () => {
    const row = { id: 'one', title: 'Work meeting', calendarId: 'work', start: '2026-11-03T18:00:00Z', end: '2026-11-03T19:00:00Z' }
    const calls: string[] = []
    setHelper(async (args) => { calls.push(args[0]); return args[0] === 'calendar-status' ? { status: 'granted' } : args[0] === 'calendars' ? [{ id: 'work', name: 'Work', source: 'Example' }, null] : [row] })
    expect(await calendars()).toEqual([{ id: 'work', name: 'Work', source: 'Example' }])
    setCalendarSelection(() => ['work'])
    expect(await upcoming(0, 1e12)).toEqual([])
    setCalendarSelection(() => [])
    expect(await upcoming(0, 1e12)).toHaveLength(1)
    setHelper(async (args) => { calls.push(args[0]); return { status: 'denied' } })
    calls.length = 0
    expect(await calendars()).toEqual([])
    expect(calls).toEqual(['calendar-status'])
  })

  it('keeps native calendar colours and ignores missing or invalid colour values', async () => {
    setHelper(async (args) => args[0] === 'calendar-status' ? { status: 'granted' } : [
      { id: 'work', name: 'Work', color: '#3478F6' },
      { id: 'personal', name: 'Personal' },
      { id: 'invalid', name: 'Invalid', color: 'url(remote)' },
    ])
    expect(await calendars()).toEqual([
      { id: 'work', name: 'Work', source: '', color: '#3478F6' },
      { id: 'personal', name: 'Personal', source: '' },
      { id: 'invalid', name: 'Invalid', source: '' },
    ])
  })

  it('asks the helper for the window and returns parsed events', async () => {
    const calls: string[][] = []
    setHelper(async (args) => { calls.push(args); return args[0] === 'calendar-status' ? { status: 'granted' } : fixture })
    const ev = await upcoming(Date.parse('2026-10-29T14:00:00Z'), Date.parse('2026-10-29T18:00:00Z'))
    expect(ev.map((e) => e.title)).toEqual(['Design review', 'Coffee', 'Sync'])
    expect(calls.find((c) => c[0] === 'events')).toEqual(['events', '2026-10-29T14:00:00.000Z', '2026-10-29T18:00:00.000Z'])
  })

  it('access denied: no events, and the status says denied', async () => {
    let asked = false
    setHelper(async (args) => { if (args[0] === 'events') asked = true; return { status: 'denied' } })
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('denied')
    expect(asked).toBe(false)
  })

  it('a helper that fails gives no events, not a crash', async () => {
    setHelper(async (args) => { if (args[0] === 'calendar-status') return { status: 'granted' }; throw new Error('boom') })
    expect(await upcoming(0, 1e12)).toEqual([])
  })

  it('refreshCalendarStatus reads the helper', async () => {
    setHelper(async () => ({ status: 'notDetermined' }))
    expect(await refreshCalendarStatus()).toBe('notDetermined')
    expect(calendarStatus()).toBe('notDetermined')
  })

  it('a helper that fails says error, not that access is off', async () => {
    setHelper(async () => { throw new Error('boom') })
    expect(await refreshCalendarStatus()).toBe('error')
    expect(await requestCalendarAccess()).toBe('error')
    setHelper(async (args) => { if (args[0] === 'calendar-status') return { status: 'granted' }; throw new Error('boom') })
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('error')
  })
})

describe('a computer without a calendar (Windows, Linux)', () => {
  afterEach(() => setCalendarSupported(true))
  it('never runs the helper: unsupported, no calendars and no events, and nothing to ask', async () => {
    const calls: string[] = []
    setHelper(async (args) => { calls.push(args[0]); return { status: 'granted' } })
    setCalendarSupported(false)
    expect(await refreshCalendarStatus()).toBe('unsupported')
    expect(await requestCalendarAccess()).toBe('unsupported')
    expect(await calendars()).toEqual([])
    expect(await upcoming(0, 1e12)).toEqual([])
    expect(calendarStatus()).toBe('unsupported')
    expect(calls).toEqual([])
  })
})
