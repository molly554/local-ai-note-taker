import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: the whole meeting (record, transcript, notes, the recording to play) on every computer the CI has, with
// the fake recorder, transcriber and notes model. The Windows and Linux runners are those computers; a Mac pretends.
const main = join(import.meta.dirname, '../out/main/index.js')
const platforms = process.platform === 'darwin' ? ['win32', 'linux'] : [process.platform]
const launch = async (platform: string, env: Record<string, string> = {}) => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: platform, YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const record = async (page: Page) => {
  await page.getByTestId('new-note').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  return (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
}

for (const platform of platforms) {
  test(`@everywhere on ${platform}: record, see the transcript, stop, and get notes and the recording`, async () => {
    const { app, page } = await launch(platform)
    try {
      const id = await record(page)
      await page.getByTestId('note-transcript-toggle').click()
      await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      await page.getByTestId('note-stop').click()
      await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
      await expect(page.getByTestId('note-enhanced-editor')).not.toBeEmpty()
      await expect.poll(() => page.evaluate((id) => window.yogurt.audio.tracks(id), id), { timeout: 30_000 }).toEqual(['me', 'them'])
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: a meeting finished before the notes model is in says how far its download is, then gets notes`, async () => {
    const { app, page } = await launch(platform, { YOGURT_FAKE_NOTES_MODEL_MS: '16000' })
    try {
      const id = await record(page)
      await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
      await page.getByTestId('note-stop').click()
      const wait = page.getByTestId('note-enhanced-model-download')
      await expect(wait).toContainText('Lynote NoteTaker is still downloading its AI model. Your notes will be ready in a few minutes.')
      await expect(wait).toContainText('%')
      await expect(page.getByTestId('note-enhanced-waiting')).toHaveCount(0)
      await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 40_000 })
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: a mic the computer blocks is said in its own words, never System Settings`, async () => {
    const { app, page } = await launch(platform)
    try {
      await record(page)
      await fake(app, 'warn', 'no-mic')
      const hint = page.getByTestId('rec-hint')
      await expect(hint).toBeVisible()
      await expect(hint).not.toContainText('System Settings')
      if (platform === 'win32') {
        await expect(hint).toContainText('Windows Settings')
        await page.getByTestId('rec-hint-fix').click()
        await expect.poll(async () => (await fake<{ systemSettings: string[] }>(app, 'main')).systemSettings).toEqual(['ms-settings:privacy-microphone'])
      } else {
        await expect(hint).toContainText('Check your sound settings.')
        await expect(page.getByTestId('rec-hint-fix')).toHaveCount(0)
      }
      await page.getByTestId('note-stop').click()
    } finally { await app.close() }
  })
}

test('a Mac waiting for the notes model says it is still downloading, and how far', async () => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), YOGURT_FAKE_NOTES_MODEL_MS: '16000' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await record(page)
    await page.getByTestId('note-stop').click()
    const wait = page.getByTestId('note-enhanced-model-download')
    await expect(wait).toHaveText(/^Lynote NoteTaker is still downloading its AI model\. Your notes will be ready in a few minutes\. \(\d+%\)$/)
    await expect(page.getByText('Generating notes')).toHaveCount(0)
  } finally { await app.close() }
})
