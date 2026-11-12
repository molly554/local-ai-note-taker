import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectUpcomingAgendaDay } from './agendaDate'

// Calendar cache/layout tests need a day that cannot roll over mid-test. The default
// +5 minute standup can be tomorrow when CI starts just before midnight.
async function seedAgendaAtNoon(app: ElectronApplication, page: Page) {
  await expect(page.getByTestId('home')).toBeVisible()
  const at = await page.evaluate(() => { const day = new Date(); day.setHours(12, 0, 0, 0); return +day })
  await page.clock.setFixedTime(at)
  await app.evaluate(async (_e, at) => {
    const fake = (globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void; advance(ms: number): Promise<void> } }).__fake__
    fake.calendarEvents([{ id: 'standup', title: 'Team standup', start: new Date(at + 5 * 60_000).toISOString(), end: new Date(at + 35 * 60_000).toISOString(), attendees: [] }])
    await fake.advance(at - Date.now())
  }, at)
  await page.reload()
  await expect(page.getByTestId('home')).toBeVisible()
}

test('agenda keeps cached days immediate, deduplicates pending reads and shows two quiet skeletons only for uncached days', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-loading-')),
  } })
  try {
    const page = await app.firstWindow()
    await seedAgendaAtNoon(app, page)
    await expect(page.getByTestId('event').filter({ hasText: 'Team standup' })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      const reads = { calls: [] as number[], comingUp: 0, pending: new Map<number, (value: unknown) => void>() }
      ;(globalThis as unknown as { agendaReads: typeof reads }).agendaReads = reads
      ipcMain.removeHandler('calendar:coming-up')
      ipcMain.handle('calendar:coming-up', () => { reads.comingUp++; return { status: 'granted', events: [] } })
      ipcMain.removeHandler('calendar:day')
      ipcMain.handle('calendar:day', (_e, at: number) => {
        reads.calls.push(at)
        return new Promise((resolve) => reads.pending.set(at, resolve))
      })
    })
    const tomorrow = () => selectUpcomingAgendaDay(page, 1)
    const today = page.getByRole('button', { name: 'Today', exact: true })
    await tomorrow()
    await expect(page.getByTestId('agenda-skeleton')).toHaveCount(2)
    await expect(page.getByTestId('event')).toHaveCount(0)
    expect(await page.getByTestId('agenda-skeleton').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    expect(await app.evaluate(() => (globalThis as unknown as { agendaReads: { comingUp: number } }).agendaReads.comingUp)).toBe(0)
    await today.click()
    await expect(page.getByTestId('event').filter({ hasText: 'Team standup' })).toBeVisible()
    await expect(page.getByTestId('agenda-skeleton')).toHaveCount(0)
    await tomorrow()
    await expect(page.getByTestId('agenda-skeleton')).toHaveCount(2)
    const calls = await app.evaluate(() => (globalThis as unknown as { agendaReads: { calls: number[] } }).agendaReads.calls)
    expect(calls).toHaveLength(2) // Tomorrow and quiet refresh of cached Today; no duplicate Tomorrow.
    await app.evaluate(() => {
      const reads = (globalThis as unknown as { agendaReads: { calls: number[]; pending: Map<number, (value: unknown) => void> } }).agendaReads
      const at = reads.calls[0]
      reads.pending.get(at)!({ status: 'granted', events: [{ id: 'new-day', title: 'Tomorrow review', start: at, end: at + 30 * 60_000, attendees: [], url: null }] })
    })
    await expect(page.getByTestId('event').filter({ hasText: 'Tomorrow review' })).toBeVisible()
    // A late answer for the day we left must not replace the selected date.
    await app.evaluate(() => {
      const reads = (globalThis as unknown as { agendaReads: { calls: number[]; pending: Map<number, (value: unknown) => void> } }).agendaReads
      reads.pending.get(reads.calls[1])!({ status: 'granted', events: [] })
    })
    await expect(page.getByTestId('event').filter({ hasText: 'Tomorrow review' })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('event').filter({ hasText: 'Tomorrow review' })).toBeVisible()
    await expect(page.getByTestId('agenda-skeleton')).toHaveCount(0)
  } finally { await app.close() }
})

test('a granted response started before access was revoked cannot refill the calendar cache', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-revoked-')),
  } })
  try {
    const page = await app.firstWindow()
    await seedAgendaAtNoon(app, page)
    await expect(page.getByTestId('event').first()).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      const pending: Array<{ at: number; resolve: (value: unknown) => void }> = []
      ;(globalThis as unknown as { agendaPending: typeof pending }).agendaPending = pending
      ipcMain.removeHandler('calendar:day')
      ipcMain.handle('calendar:day', (_e, at: number) => new Promise((resolve) => pending.push({ at, resolve })))
    })
    await selectUpcomingAgendaDay(page, 1)
    await selectUpcomingAgendaDay(page, 2)
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { agendaPending: unknown[] }).agendaPending.length)).toBe(2)
    await app.evaluate(() => {
      const pending = (globalThis as unknown as { agendaPending: Array<{ at: number; resolve: (value: unknown) => void }> }).agendaPending
      pending[1].resolve({ status: 'denied', events: [] })
    })
    await expect(page.getByTestId('calendar-off')).toContainText('Calendar access is off')
    await app.evaluate(() => {
      const pending = (globalThis as unknown as { agendaPending: Array<{ at: number; resolve: (value: unknown) => void }> }).agendaPending
      const { at, resolve } = pending[0]
      resolve({ status: 'granted', events: [{ id: 'stale', title: 'Stale event', start: at, end: at + 60_000, attendees: [], url: null }] })
    })
    await selectUpcomingAgendaDay(page, 1)
    await expect(page.getByTestId('agenda-skeleton')).toHaveCount(2)
    await expect(page.getByTestId('event')).toHaveCount(0)
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { agendaPending: unknown[] }).agendaPending.length)).toBe(3)
  } finally { await app.close() }
})

test('agenda uses each date once while preserving Today and Tomorrow labels', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-date-')),
  } })
  try {
    const page = await app.firstWindow()
    await seedAgendaAtNoon(app, page)
    await expect(page.getByTestId('home')).toBeVisible()
    const heading = page.locator('.agenda-day h3'), date = page.locator('.agenda-day > span')
    await expect(heading).toHaveText('Today')
    await selectUpcomingAgendaDay(page, 1)
    await expect(heading).toHaveText('Tomorrow')
    await selectUpcomingAgendaDay(page, 2)
    const expected = await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() + 2)
      return { weekday: d.toLocaleDateString('en', { weekday: 'long' }), date: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) }
    })
    await expect(heading).toHaveText(expected.weekday)
    await expect(date).toHaveText(expected.date)
  } finally { await app.close() }
})

test('the compact calendar keeps its original type and geometry with a bright today in both themes', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-states-')),
  } })
  try {
    const page = await app.firstWindow()
    await seedAgendaAtNoon(app, page)
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await expect(page.locator('.workspace')).toHaveClass(/sidebar-collapsed/)
    const week = page.locator('.agenda-week')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      const today = week.locator('[aria-current=date]')
      await expect(today.locator('b')).toHaveCSS('background-color', 'rgb(111, 0, 255)')
      await expect(today.locator('b')).toHaveCSS('color', 'rgb(255, 255, 255)')
      await expect(today.locator('b')).toHaveCSS('font-size', '11px')
      await expect(today.locator('b')).toHaveCSS('width', '26px')
      await expect(today.locator('b')).toHaveCSS('height', '26px')
      await expect(today.locator('span')).toHaveCSS('font-size', '10px')
      await expect(page.locator('.agenda-day h3')).toHaveCSS('font-size', '13px')
      await expect(page.locator('.agenda-day h3')).toHaveCSS('font-weight', '600')
      await expect(page.locator('.agenda-day > span')).toHaveCSS('font-size', '11px')
      await expect(page.locator('.agenda-day > span')).toHaveCSS('font-weight', '400')
      const other = week.locator('button:not([aria-current=date])').first()
      await other.focus()
      await page.keyboard.press('Space')
      await expect(other).toHaveAttribute('aria-pressed', 'true')
      await expect(today).toHaveAttribute('aria-pressed', 'false')
      await expect(today.locator('b')).toHaveCSS('background-color', 'rgb(111, 0, 255)')
      await today.hover()
      await expect(today.locator('b')).toHaveCSS('background-color', 'rgb(111, 0, 255)')
      await expect(other.locator('b')).toHaveCSS('background-color', colorScheme === 'light' ? 'rgb(241, 230, 255)' : 'rgb(44, 22, 74)')
      await expect(other).toHaveCSS('outline-style', 'solid')
      await expect(other).toHaveCSS('outline-width', '2px')
      // Logical order and hit targets stay within the compact calendar in either direction.
      for (const dir of ['ltr', 'rtl']) {
        await page.evaluate((direction) => document.documentElement.dir = direction, dir)
        const bounds = (await week.boundingBox())!
        for (const day of await week.locator('button').all()) {
          const box = (await day.locator('b').boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1)
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
        }
      }
      await page.evaluate(() => document.documentElement.dir = 'ltr')
      await today.focus()
      await page.keyboard.press('Space')
      await expect(today).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.agenda-day h3')).toHaveText('Today')
    }
  } finally { await app.close() }
})
