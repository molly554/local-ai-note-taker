import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('week arrows browse seven dates without changing the agenda; choosing a day loads it and Today resets both', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-header-')),
  } })
  try {
    const page = await app.firstWindow()
    await page.clock.install({ time: new Date(2026, 10, 30, 12) })
    await page.reload()
    const agenda = page.getByRole('complementary', { name: 'Agenda' })
    const header = agenda.locator('.agenda-header')
    const today = header.getByRole('button', { name: 'Today', exact: true })
    const month = agenda.locator('.agenda-month')
    const dates = agenda.locator('.agenda-week button')
    const labels = () => dates.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    const reads = () => app.evaluate(() => (globalThis as unknown as { agendaReads: number[] }).agendaReads)
    await expect(header.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
    await expect(agenda.getByTestId('coming-up')).toBeVisible()
    const originalLabels = await labels()
    const originalAgenda = (await agenda.getByTestId('coming-up').textContent())!
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as unknown as { agendaReads: number[] }).agendaReads = []
      ipcMain.removeHandler('calendar:day')
      ipcMain.handle('calendar:day', (_e, at: number) => {
        ;(globalThis as unknown as { agendaReads: number[] }).agendaReads.push(at)
        return { status: 'granted', events: [{ id: 'selected', title: 'Selected date event', start: at, end: at + 60_000, attendees: [], url: null }] }
      })
    })
    await expect(month).toHaveText('November 2026')
    await agenda.locator('.agenda-navigation button').last().click()
    await expect.poll(labels).toEqual([
      'Sunday, December 6', 'Monday, December 7', 'Tuesday, December 8', 'Wednesday, December 9',
      'Thursday, December 10', 'Friday, December 11', 'Saturday, December 12',
    ])
    await expect(month).toHaveText('December 2026')
    await expect(agenda.getByRole('button', { name: 'Next week', exact: true })).toBeVisible()
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Nov 30')
    await expect(agenda.locator('.agenda-day h3')).toHaveText('Today')
    await expect(agenda.getByTestId('coming-up')).toHaveText(originalAgenda)
    await expect(agenda.locator('.agenda-week [aria-pressed=true]')).toHaveCount(0)
    expect(await reads()).toEqual([])
    await agenda.getByRole('button', { name: 'Tuesday, December 8', exact: true }).click()
    await expect(agenda.getByTestId('event')).toContainText('Selected date event')
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 8')
    expect(await reads()).toEqual([new Date(2026, 11, 8, 12).getTime()])
    await agenda.getByRole('button', { name: 'Previous week', exact: true }).click()
    await expect.poll(labels).toEqual(originalLabels)
    await expect(month).toHaveText('November 2026')
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 8')
    expect(await reads()).toHaveLength(1)
    // Crossing a year is also display-only until a date is chosen.
    for (let i = 0; i < 5; i++) await agenda.getByRole('button', { name: 'Next week', exact: true }).click()
    await expect(month).toHaveText('January 2027')
    await expect(agenda.locator('.agenda-day > span')).toHaveText('Dec 8')
    expect(await reads()).toHaveLength(1)
    await today.focus()
    await page.keyboard.press('Enter')
    await expect.poll(labels).toEqual(originalLabels)
    await expect(month).toHaveText('November 2026')
    await expect(agenda.locator('.agenda-day h3')).toHaveText('Today')
    await expect(agenda.locator('.agenda-week [aria-current=date]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(reads).toEqual([new Date(2026, 11, 8, 12).getTime(), new Date(2026, 10, 30, 12).getTime()])
  } finally { await app.close() }
})
