import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: these also run on the Windows and Linux CI. YOGURT_FAKE_PLATFORM lets the Mac try those screens too.
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), ...env } })

for (const platform of ['win32', 'linux']) {
  test(`@everywhere on ${platform}: no agenda, and Settings has no calendar or names from calls`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      expect(await page.evaluate(() => window.yogurt.capabilities)).toEqual({ calendar: false, callNames: false, permissionPrompts: false, mediaPause: false })
      await expect(page.getByRole('complementary', { name: 'Agenda' })).toHaveCount(0)
      await page.getByTestId('settings-open').click()
      await expect(page.getByTestId('settings')).toBeVisible()
      await expect(page.getByTestId('permission-row')).toHaveCount(3)
      await expect(page.locator('[data-testid="permission-row"][data-kind="calendar"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="permission-row"][data-kind="accessibility"]')).toHaveCount(0)
      await expect(page.getByTestId('calendar-settings')).toHaveCount(0)
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: the first run asks for nothing (no prompts there; mic, call audio and notifications are on)`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' })
    try {
      const page = await app.firstWindow()
      await page.getByTestId('intro-next').click()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('onboarding-step')).toHaveCount(0)
    } finally { await app.close() }
  })
}

test('@everywhere a Mac keeps the agenda and every permission', async () => {
  const app = await launch({ YOGURT_FAKE_PLATFORM: 'darwin' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => window.yogurt.capabilities)).toEqual({ calendar: true, callNames: true, permissionPrompts: true, mediaPause: true })
    await expect(page.getByRole('complementary', { name: 'Agenda' })).toBeVisible()
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('permission-row')).toHaveCount(5)
    await expect(page.getByTestId('calendar-settings')).toBeVisible()
  } finally { await app.close() }
})
