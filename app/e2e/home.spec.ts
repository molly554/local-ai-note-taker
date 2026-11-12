import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Meeting } from '../src/shared/types'
import { selectUpcomingAgendaDay } from './agendaDate'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const routeOf = (page: Page) => page.evaluate(() => window.yogurt.nav.current())
const meetingOf = (page: Page, id: string) => page.evaluate((id) => window.yogurt.meetings.get(id), id) as Promise<Meeting>

// Prepared notes remain supported by the backend, but the agenda no longer creates one on click.
async function prepareCalendarNote(page: Page, title: string) {
  const id = await page.evaluate(async (title) => {
    const at = Date.now()
    const event = (await window.yogurt.calendar.day(at)).events.find(event => event.title === title)
    if (!event) throw new Error(`Missing calendar fixture: ${title}`)
    const result = await window.yogurt.meetings.prepare(event.id, at)
    if (!('id' in result)) throw new Error(`Could not prepare calendar fixture: ${result.error}`)
    return result.id
  }, title)
  await expect.poll(() => routeOf(page)).toBe(`/note/${id}`)
  return id
}

test('meeting rows show captured duration, excluding gaps, only after recording finishes', async () => {
  const { app, page, userData } = await launch()
  const db = new DatabaseSync(join(userData, 'yogurt.db'))
  try {
    await fake(app, 'manyMeetings', 6)
    db.prepare("UPDATE meetings SET duration_ms = ?, ended_at = started_at + ? WHERE title = 'Budget review'").run(32 * 60_000, 2 * 24 * 60 * 60_000)
    db.prepare("UPDATE meetings SET duration_ms = NULL, ended_at = started_at + ? WHERE title = 'Weekly sync'").run(35 * 60_000)
    db.prepare("UPDATE meetings SET duration_ms = 2000 WHERE title = 'Customer call with Acme'").run()
    db.prepare("UPDATE meetings SET state = 'prepared', ended_at = NULL, duration_ms = NULL WHERE title = 'Design crit'").run()
    db.prepare("UPDATE meetings SET state = 'stopped', ended_at = NULL, duration_ms = NULL WHERE title = '1:1 with Maya'").run()
    db.prepare("UPDATE meetings SET state = 'recording', ended_at = NULL, duration_ms = ? WHERE title = 'Hiring loop'").run(44 * 60_000)
    await page.reload()
    const card = (title: string) => page.getByTestId('past-note').filter({ hasText: title })
    await expect(card('Budget review').getByTestId('past-note-duration')).toHaveText('32 min')
    await expect(card('Weekly sync').getByTestId('past-note-duration')).toHaveText('35 min')
    await expect(card('Customer call with Acme').getByTestId('past-note-duration')).toHaveText('1 min')
    for (const title of ['Design crit', '1:1 with Maya', 'Hiring loop']) await expect(card(title).getByTestId('past-note-duration')).toHaveCount(0)
    await expect(card('Hiring loop')).toContainText('Recording')
    await expect(page.getByRole('heading', { name: 'Your meetings', exact: true })).toBeVisible()
  } finally { db.close(); await app.close() }
})

test('a prepared calendar note keeps its notes without recording; Start recording reuses it; ⌘K finds its contents', async () => {
  const { app, page } = await launch()
  try {
    const coming = page.getByTestId('coming-up')
    const standup = coming.getByTestId('event').filter({ hasText: 'Team standup' })
    await expect(standup).toBeVisible()
    await expect(standup.locator('.agenda-people')).toHaveText('Ann, Bo')
    await expect(standup.locator('.agenda-people')).toHaveAttribute('title', 'Ann Lee, Bo Park')
    await selectUpcomingAgendaDay(page, 1)
    await expect(coming.getByTestId('event').filter({ hasText: 'Design review' })).toBeVisible()
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(standup).toBeVisible()
    await expect(page.getByTestId('past-empty')).toBeVisible()

    const id = await prepareCalendarNote(page, 'Team standup')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    const m = await meetingOf(page, id)
    expect(m).toMatchObject({ title: 'Team standup', state: 'prepared', app: null })
    expect(m.eventId).toContain('fake-standup')
    expect(m.attendees.map((a) => a.name)).toEqual(['Ann Lee', 'Bo Park'])

    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('Check the pricing page with Ann')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine, { timeout: 5000 }).toContain('pricing')
    await page.getByTestId('nav-home').click()
    await standup.getByTestId('event-details').click()
    await page.getByTestId('event-open').click()
    expect(await routeOf(page)).toBe(`/note/${id}`)
    expect((await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))).filter((c) => c.state === 'recording')).toEqual([])
    await page.getByTestId('note-transcript-toggle').click()
    await page.getByTestId('note-start').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await routeOf(page)).toBe(`/note/${id}`)
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-mine')).toBeVisible()
    await expect(page.getByTestId('note-mine')).toContainText('Check the pricing page with Ann')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()

    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    const card = page.getByTestId('past-note').filter({ hasText: 'Team standup' })
    await expect(card).toBeVisible()
    // the two invited, and Cy Dao, whom the fake Zoom call shows too (names from the call join the attendees)
    await expect(card.getByTestId('past-note-attendees')).toHaveText('Ann, Bo, Cy')
    await expect(card.getByTestId('past-note-preview')).toHaveCount(0)
    await expect(page.getByTestId('past-day').first()).toContainText('Today')

    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    await page.keyboard.type('pricing')
    const hit = search.getByTestId('search-result').filter({ hasText: 'Team standup' })
    await expect(hit).toBeVisible()
    await expect(hit.locator('mark').first()).toHaveText(/pricing/i)
    await page.keyboard.press('Enter')
    await expect(search).toHaveCount(0)
    await expect(page.getByTestId('note-title')).toHaveText('Team standup')
    expect(await routeOf(page)).toBe(`/note/${id}`)
    await page.getByTestId('note-attendees').click()
    for (const name of ['Ann Lee', 'Bo Park', 'Cy Dao']) await expect(page.getByTestId('people-list')).toContainText(name)
  } finally { await app.close() }
})

test('agenda opens details on demand, opens only existing notes, and offers recording inline for the current event', async () => {
  const { app, page } = await launch()
  try {
    // Keep past/current/upcoming fixture rows on one day even when CI runs at midnight.
    const now = await page.evaluate(() => { const day = new Date(); day.setHours(12, 0, 0, 0); return +day })
    await page.clock.setFixedTime(now)
    await app.evaluate(async (_e, at) => {
      await (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void> } }).__fake__.advance(at - Date.now())
    }, now)
    await fake(app, 'calendarEvents', [
      { id: 'past', title: 'Earlier meeting', start: new Date(now - 600000).toISOString(), end: new Date(now - 300000).toISOString(), attendees: [] },
      { id: 'live', title: 'Current meeting', start: new Date(now - 60000).toISOString(), end: new Date(now + 300000).toISOString(), attendees: [] },
      { id: 'next', title: 'Later meeting', start: new Date(now + 600000).toISOString(), end: new Date(now + 900000).toISOString(), attendees: [] },
    ])
    await page.reload()
    const event = (title: string) => page.getByTestId('event').filter({ hasText: title })
    const details = page.getByTestId('event-details-content')
    await expect(page.getByTestId('event')).toHaveCount(3)
    await expect(details).toHaveCount(0)
    await expect(page.getByTestId('event-prepare')).toHaveCount(0)
    await expect(page.getByTestId('event-open')).toHaveCount(0)
    await expect(page.getByTestId('event-start')).toHaveCount(1)
    await expect(event('Current meeting').getByTestId('event-start')).toBeVisible()
    // The time/body area belongs to the event button too, without wrapping Take notes in a button.
    await event('Earlier meeting').click({ position: { x: 20, y: 8 } })
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(details.getByRole('heading')).toHaveText('Earlier meeting')
    await expect(details.getByTestId('event-open')).toHaveCount(0)
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))).toEqual([])
    await details.getByRole('button', { name: 'Close', exact: true }).click()

    const earlier = await prepareCalendarNote(page, 'Earlier meeting')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.getByTestId('nav-home').click()
    await event('Earlier meeting').getByTestId('event-details').focus()
    await page.keyboard.press('Enter')
    await details.getByRole('button', { name: 'Open note', exact: true }).click()
    expect(await routeOf(page)).toBe(`/note/${earlier}`)
    const current = await prepareCalendarNote(page, 'Current meeting')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.getByTestId('nav-home').click()
    await event('Current meeting').getByTestId('event-start').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await routeOf(page)).toBe(`/note/${current}`)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('event-start')).toHaveCount(0)
    await expect(event('Current meeting').locator('.agenda-live')).toHaveText('Recording')
    await event('Current meeting').getByTestId('event-details').click()
    await details.getByRole('button', { name: 'Open note', exact: true }).click()
    expect(await routeOf(page)).toBe(`/note/${current}`)
    await page.getByTestId('note-stop').click()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('event-start')).toHaveCount(0)
  } finally { await app.close() }
})

test('New note records with no event, and nothing records before the click', async () => {
  const { app, page } = await launch()
  try {
    expect(await fake<{ route: string }>(app, 'main')).toMatchObject({ route: '' })
    // Start recording stays in the header for both populated and empty libraries.
    await fake(app, 'manyMeetings', 1)
    await page.reload()
    await expect(page.getByTestId('new-note')).toBeVisible()
    await expect(page.getByTestId('new-note')).toHaveText('Start recording')
    const before = await page.evaluate(() => window.yogurt.meetings.cards({ limit: 50 }))
    expect(before.filter((c) => c.state === 'recording')).toEqual([])
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const m = await meetingOf(page, (await routeOf(page)).slice('/note/'.length))
    expect(m).toMatchObject({ eventId: null, attendees: [], state: 'recording' })
    // while it records, home says so and takes you back to it
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('recording-return')).toBeVisible()
    await expect(page.getByTestId('new-note')).toHaveCount(0)
    await page.getByTestId('recording-return').click()
    await expect(page.getByTestId('note')).toBeVisible()
  } finally { await app.close() }
})

test('no meetings yet: plain words and one button', async () => {
  const { app, page } = await launch()
  try {
    const empty = page.getByTestId('past-empty')
    await expect(empty).toBeVisible()
    await expect(empty.getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toHaveCount(1)
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  } finally { await app.close() }
})

test('calendar not asked yet: one button asks, then the meetings show', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'notDetermined' })
  try {
    const off = page.getByTestId('calendar-off')
    await expect(off).toBeVisible()
    await expect(off.getByRole('button')).toHaveCount(1)
    await off.getByRole('button').click()
    await expect(page.getByTestId('coming-up').getByTestId('event').filter({ hasText: 'Team standup' })).toBeVisible()
  } finally { await app.close() }
})

test('calendar access turned off: the one button opens the Mac settings', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'denied' })
  try {
    const off = page.getByTestId('calendar-off')
    await expect(off).toBeVisible()
    await expect(off.getByRole('button')).toHaveCount(1)
    await off.getByRole('button').click()
    await expect.poll(async () => (await fake<{ settingsOpened: number }>(app, 'main')).settingsOpened).toBe(1)
  } finally { await app.close() }
})

test('500 past meetings: the list opens fast, grouped by day, and loads more as you scroll', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 500)
    await page.reload()
    const t0 = Date.now()
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    expect(Date.now() - t0).toBeLessThan(1500)
    const first = await page.getByTestId('past-note').count()
    expect(first).toBeLessThan(100)
    expect(await page.getByTestId('past-day').count()).toBeGreaterThan(3)
    for (let i = 0; i < 30 && (await page.getByTestId('past-note').count()) < 500; i++) {
      await page.getByTestId('past-more').scrollIntoViewIfNeeded().catch(() => {})
      await page.waitForTimeout(100)
    }
    await expect(page.getByTestId('past-note')).toHaveCount(500)
    await expect(page.getByTestId('past-more')).toHaveCount(0)
  } finally { await app.close() }
})

test('search: from any screen, as you type, arrows and Enter, Esc closes; a slow older answer never replaces a newer one', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SEARCH_SLOW: '1' })
  try {
    await fake(app, 'manyMeetings', 40)
    await page.reload()
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    // from a note too
    await page.getByTestId('past-note').first().click()
    await expect(page.getByTestId('note')).toBeVisible()
    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    // nothing typed: the latest notes
    await expect(search.getByTestId('search-result').first()).toBeVisible()
    // a short query answers slowly (fake), a longer one fast: the newer one must stay
    await page.keyboard.type('cust')
    await page.waitForTimeout(200)
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('budget')
    await expect(search.getByTestId('search-result').first()).toContainText('Budget')
    await page.waitForTimeout(1200)
    const results = search.getByTestId('search-result')
    for (const r of await results.all()) await expect(r.locator('mark').first()).toHaveText(/budget/i)
    await page.keyboard.press('ArrowDown')
    await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
    const title = (await results.nth(1).getByTestId('search-result-title').textContent())!
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText(title)
    await page.keyboard.press('Meta+k')
    await expect(search).toBeVisible()
    await page.keyboard.type('zzqx')
    await expect(search.getByTestId('search-none')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
  } finally { await app.close() }
})

test('search finds Chinese and Japanese words inside a line, and markup in a note never runs', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 3)
    await page.reload()
    // on a busy machine the reload can still be starting when ⌘K is pressed; wait for the meetings, then the box
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toBeVisible()
    await page.keyboard.type('预算')
    const hit = page.getByTestId('search-result').first()
    await expect(hit).toBeVisible()
    await expect(hit.locator('mark').first()).toContainText('预算')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.type('script')
    await expect(page.getByTestId('search-result').first()).toContainText('<img')
    expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined()
  } finally { await app.close() }
})

test('search gives focus back to where it was, keeps keys inside, and only ⌘K opens it', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 5)
    await page.reload()
    await page.getByTestId('past-note').first().click()
    const editor = page.getByTestId('note-enhanced-editor').or(page.getByTestId('note-mine'))
    await editor.click()
    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(search).toBeVisible()
    // a click on the panel's padding, then Tab: the keys still reach the search
    await search.click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('search-shortcuts')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    expect(await editor.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    // Control+K is not the shortcut on a Mac
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(200)
    await expect(search).toHaveCount(0)
  } finally { await app.close() }
})

test('Enter right after typing opens the note that matches, not a result from before', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 12)
    await page.reload()
    await page.getByTestId('search-open').click()
    await expect(page.getByTestId('search-result').first()).toBeVisible()
    await page.keyboard.type('roadmap')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText('Roadmap planning')
  } finally { await app.close() }
})

test('day names move on at midnight without a reload', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 2)
    await page.clock.install({ time: Date.now() })
    await page.reload()
    const first = page.getByTestId('past-day').first()
    await expect(first).toBeVisible()
    const was = await first.textContent()
    const midnight = new Date(); midnight.setHours(24, 1, 0, 0)
    await page.clock.fastForward(midnight.getTime() - Date.now())
    await expect(first).not.toHaveText(was!)
  } finally { await app.close() }
})

test('starting an event gone from the calendar says so plainly, and records nothing', async () => {
  const { app, page } = await launch()
  try {
    const now = Date.now()
    await fake(app, 'calendarEvents', [{ id: 'vanishing', title: 'Current meeting', start: new Date(now - 60000).toISOString(), end: new Date(now + 300000).toISOString(), attendees: [] }])
    await page.reload()
    await expect(page.getByTestId('event-start')).toBeVisible()
    await fake(app, 'calendarEvents', [])
    await page.getByTestId('event-start').click()
    await expect(page.getByTestId('home-message')).toHaveText('That meeting is no longer on your calendar.')
    await expect(page.getByTestId('home')).toBeVisible()
    expect((await page.evaluate(() => window.yogurt.meetings.cards({ limit: 5 }))).length).toBe(0)
    // the list catches up with the calendar
    await expect(page.getByTestId('event')).toHaveCount(0)
  } finally { await app.close() }
})

test('a calendar that cannot be read says so, with Try again', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_CALENDAR: 'error' })
  try {
    const off = page.getByTestId('calendar-error')
    await expect(off).toBeVisible()
    await expect(off.getByRole('button')).toHaveText('Try again')
    await expect(page.getByTestId('calendar-off')).toHaveCount(0)
    await fake(app, 'calendarStatus', 'granted')
    await off.getByRole('button').click()
    await expect(page.getByTestId('event').first()).toBeVisible()
  } finally { await app.close() }
})


test('workspace navigation stays usable with the sidebar closed; nothing in it is marked as not built yet', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 4)
    await page.reload()
    await page.getByTestId('sidebar-collapse').click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toBeVisible()
    await page.getByTestId('search-input').fill('')
    await expect(page.getByTestId('search-result').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('sidebar-expand').click()
    await page.getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await expect(page.getByTestId('trash-page')).toContainText('The Trash is empty')
    await expect(page.getByText('Planned', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'All meetings', exact: true })).toHaveCount(0)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('past-note')).toHaveCount(4)
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
  } finally { await app.close() }
})

test('unlinking a prepared calendar note keeps the edited title, people and notes', async () => {
  const { app, page } = await launch()
  try {
    const id = await prepareCalendarNote(page, 'Team standup')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.evaluate(async (id) => {
      await window.yogurt.meetings.rename(id, 'Our planning agenda')
      await window.yogurt.meetings.setAttendees(id, [{ name: 'Maya Chen', email: 'maya@example.com' }])
    }, id)
    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('Keep the release date and launch checklist.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toContain('launch checklist')
    await page.getByTestId('note-date').click()
    await page.getByTestId('note-date-events-toggle').click()
    await page.getByTestId('note-date-unlink').click()
    await expect.poll(async () => (await meetingOf(page, id)).eventId).toBeNull()
    expect(await meetingOf(page, id)).toMatchObject({ title: 'Our planning agenda', state: 'prepared', attendees: [{ name: 'Maya Chen', email: 'maya@example.com' }] })
    await expect(page.getByTestId('note-mine')).toContainText('launch checklist')
    await expect(page.getByTestId('note-date-card')).not.toContainText('Our planning agenda')
    await expect(page.getByTestId('note-date-card').getByRole('button', { name: 'Open note' })).toHaveCount(0)
  } finally { await app.close() }
})

test('agenda date navigation keeps the column width and the selected date stays legible on hover', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByTestId('event').first()).toBeVisible()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    const before = await agenda.boundingBox()
    const selected = agenda.locator('.agenda-week button[aria-pressed="true"]')
    const colors = () => selected.locator('b').evaluate((el) => ({ ink: getComputedStyle(el).color, surface: getComputedStyle(el).backgroundColor }))
    const normal = await colors()
    await selected.hover()
    expect(await colors()).toEqual(normal)
    await selectUpcomingAgendaDay(page, 1)
    await expect(page.getByTestId('event').filter({ hasText: 'Design review' })).toBeVisible()
    await selectUpcomingAgendaDay(page, 2)
    await expect(agenda.getByRole('heading', { name: 'No meetings', exact: true })).toBeVisible()
    await expect(agenda).toContainText('Your calendar is clear.')
    const empty = await agenda.boundingBox()
    expect(empty?.x).toBe(before?.x)
    expect(empty?.width).toBe(before?.width)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await page.getByTestId('event-details').first().click()
    await expect(page.getByTestId('event-details-content')).toContainText('Ann Lee')
    await expect(page.getByTestId('event-details-content').getByRole('link', { name: 'Join meeting' })).toBeVisible()
  } finally { await app.close() }
})

test('agenda detail cards support keyboard entry, dismissal and return focus without trapping the page', async () => {
  const { app, page } = await launch()
  try {
    const at = new Date(); at.setHours(12, 0, 0, 0)
    const base = { start: at.toISOString(), end: new Date(at.getTime() + 30 * 60_000).toISOString() }
    await fake(app, 'calendarEvents', [
      { ...base, id: 'no-details', title: 'Focus time', attendees: [], url: '   ' },
      { ...base, id: 'people-only', title: 'In-person planning', attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo Park', email: null }], url: null },
      { ...base, id: 'link-only', title: 'Open office hours', attendees: [], url: 'https://meet.google.com/fak-eeve-ntx' },
    ])
    await page.reload()
    const event = (title: string) => page.getByTestId('event').filter({ has: page.getByRole('button', { name: title, exact: true }) })
    const details = page.getByTestId('event-details-content')
    await event('Focus time').getByTestId('event-details').click()
    await expect(details.getByRole('heading')).toHaveText('Focus time')
    await expect(details).toContainText('12:00 PM – 12:30 PM')
    await expect(details.getByRole('link')).toHaveCount(0)
    await expect(details.getByTestId('event-open')).toHaveCount(0)
    expect(await details.evaluate(el => el.matches(':modal'))).toBe(false)
    await expect(details.getByRole('heading')).toBeFocused()
    await expect(details.getByRole('button', { name: 'Close', exact: true })).not.toBeFocused()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(event('Focus time').getByTestId('event-details')).toBeFocused()

    const people = event('In-person planning')
    await people.getByTestId('event-details').click()
    const attendeeNames = details.getByRole('list', { name: 'People' }).getByRole('listitem')
    await expect(attendeeNames).toHaveText(['Ann Lee', 'Bo Park'])
    await expect(details.getByText('ann@example.com', { exact: true })).toHaveCount(0)
    await attendeeNames.first().hover()
    await expect(attendeeNames.first()).toHaveAttribute('title', 'ann@example.com')
    await expect(details.getByRole('link')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(details).toBeVisible()
    await expect(people).toHaveAttribute('data-selected', 'true')
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(details).toHaveCount(0)
    await expect(people.getByTestId('event-details')).toBeFocused()
    await expect(people).toHaveAttribute('data-selected', 'false')

    const link = event('Open office hours')
    await link.getByTestId('event-details').focus()
    await expect(link.getByTestId('event-details')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(details.getByRole('heading')).toHaveText('Open office hours')
    await expect(details.getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://meet.google.com/fak-eeve-ntx')
    await expect(details.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(details.getByTestId('event-open')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(details.getByRole('link', { name: 'Join meeting' })).toBeFocused()
    // The card is nonmodal: a click in the rest of the page dismisses it and still works.
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(details).toHaveCount(0)
  } finally { await app.close() }
})

test('each agenda day shows only its own meetings, once, even when a meeting is on two calendars', async () => {
  const { app, page } = await launch()
  try {
    const day = (offset: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d }
    // a meeting shared onto a second calendar comes from the Mac twice, with the same id
    const on = (offset: number, hour: number, title: string, calendar = 'Work') => {
      const at = day(offset, hour)
      return { id: `${title}:${at.toISOString()}`, title, calendar, start: at.toISOString(), end: new Date(at.getTime() + 30 * 60_000).toISOString(), attendees: [], url: null }
    }
    await fake(app, 'calendarEvents', [
      on(0, 9, 'Standup'), on(0, 9, 'Standup', 'Shared'), on(0, 12, 'Speed round'), on(0, 12, 'Speed round', 'Shared'),
      on(1, 8, 'Swimming'), on(1, 9, 'Standup'), on(1, 9, 'Standup', 'Shared'), on(1, 13, 'Lunch'),
      on(2, 9, 'Vendor call'), on(2, 9, 'Vendor call', 'Shared'), on(2, 11, 'Dedupe review'), on(2, 11, 'Dedupe review', 'Shared'),
    ])
    await page.reload()
    const titles = page.getByTestId('coming-up').locator('.agenda-title')
    const expectDay = async (list: string[]) => {
      await expect(titles).toHaveText(list)
      // and it stays that way: no rows from another day linger once the list settles
      await page.waitForTimeout(300)
      await expect(titles).toHaveText(list)
    }
    const today = ['Standup', 'Speed round'], tomorrow = ['Swimming', 'Standup', 'Lunch'], after = ['Vendor call', 'Dedupe review']
    await expectDay(today)
    await selectUpcomingAgendaDay(page, 1)
    await expectDay(tomorrow)
    await selectUpcomingAgendaDay(page, 2)
    await expectDay(after)
    await selectUpcomingAgendaDay(page, 1)
    await expectDay(tomorrow)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expectDay(today)
    // a day picked on the week strip (tomorrow is on it unless today is Saturday)
    const strip = page.getByRole('button', { name: day(1, 12).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }), exact: true })
    if (await strip.count()) { await strip.click(); await expectDay(tomorrow) }
  } finally { await app.close() }
})
