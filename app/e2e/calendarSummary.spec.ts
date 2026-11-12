import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const before = process.env.YOGURT_UI_REVIEW === 'before'

test('calendar disclosure summarizes the enabled selection and stays useful when empty or unavailable', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-calendar-summary-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as any).__fake__.calendarEvents(['Work', 'Personal', 'Family'].map((name, i) => ({
      id: `event-${i}`, title: name, calendarId: name.toLowerCase(), calendar: name, calendarSource: 'Example account', calendarColor: '#3478F6', start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(),
    }))))
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('calendar-settings-toggle'), section = page.getByTestId('calendar-settings'), summary = page.getByTestId('calendar-settings-summary')
    if (!before) {
      await expect(section.getByRole('heading', { name: 'Calendars', exact: true })).toBeVisible()
      await expect(section.locator('.settings-group')).toBeVisible()
      await toggle.focus()
      await toggle.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(section.locator('.settings-calendar-dot').first()).toHaveCSS('background-color', 'rgb(52, 120, 246)')
      await toggle.press('Space')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(section.locator('.settings-group')).toBeVisible()
    }
    await toggle.scrollIntoViewIfNeeded()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      if (!before) await expect(summary).toContainText('and 2 more')
      await section.screenshot({ path: info.outputPath(`calendars-${colorScheme}-collapsed.png`) })
      await toggle.click()
      await expect(page.getByTestId('calendar-choice')).toHaveCount(3)
      await section.screenshot({ path: info.outputPath(`calendars-${colorScheme}-expanded.png`) })
      await toggle.click()
    }
    if (!before) {
      await toggle.click()
      for (const name of ['Work', 'Family']) await page.getByTestId('calendar-choice').filter({ hasText: name }).getByRole('checkbox').uncheck()
      await expect(summary).toHaveText('Personal · Example account')
      await page.getByTestId('calendar-choice').filter({ hasText: 'Personal' }).getByRole('checkbox').uncheck()
      await expect(summary).toHaveText('No calendars selected.')
      await toggle.click()
      for (const status of ['denied', 'error', 'granted']) {
        await app.evaluate(({ ipcMain }, status) => { ipcMain.removeHandler('calendar:list'); ipcMain.handle('calendar:list', () => ({ status, calendars: [] })) }, status)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect(summary).toHaveText(status === 'denied' ? 'Allow calendar access to choose your calendars.' : status === 'error' ? "Yogurt couldn't read your calendars." : 'No calendars found on this Mac.')
      }
    }
  } finally { await app.close() }
})
