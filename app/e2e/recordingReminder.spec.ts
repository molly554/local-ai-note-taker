import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const theme of ['light', 'dark'] as const) test(`standard recording reminder toast in ${theme}, once per recording`, async ({}, info) => {
  test.setTimeout(180_000)
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-reminder-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.setContentSize(1200, 800))
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
      window.dispatchEvent(new Event('focus'))
    })
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const toast = page.getByTestId('recording-reminder')
    await expect(toast).toHaveText("Let everyone know you're recording.")
    await expect(toast).toHaveClass(/app-toast/)
    await expect(page.locator('p.recording-reminder')).toHaveCount(0)
    await expect(page.getByTestId('transcript-consent')).toHaveCount(0)
    // no countdown bar; hovering holds it
    await expect(toast.locator('[data-animate-ui-toast-progress-bar]')).toHaveCount(0)
    await toast.hover()
    await page.screenshot({ path: info.outputPath(`reminder-${theme}-closed.png`) })
    await page.getByTestId('chat-open').click()
    await expect.poll(async () => {
      const a = await toast.boundingBox(), b = await page.getByTestId('chat-panel').boundingBox()
      return !!a && !!b && a.x + a.width + 10 <= b.x
    }).toBe(true)
    await toast.hover()
    await page.locator('.chat-morph-surface').evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)))
    await page.screenshot({ path: info.outputPath(`reminder-${theme}-ask.png`) })
    await page.keyboard.press('F6')
    await toast.getByRole('button', { name: 'Close', exact: true }).focus()
    await page.mouse.move(0, 0)
    // the 4 s timer holds: past it, the reminder is still there
    await page.waitForTimeout(4500)
    await expect(toast).toBeVisible()
    await page.getByTestId('chat-close').click()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
      window.dispatchEvent(new Event('blur'))
    })
    // the 4 s timer holds: past it, the reminder is still there
    await page.waitForTimeout(4500)
    await expect(toast).toBeVisible()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
      window.dispatchEvent(new Event('focus'))
    })
    await page.getByTestId('chat-open').focus()
    await expect(toast).toHaveCount(0, { timeout: 6000 })
    await page.getByTestId('note-pause').click()
    await page.getByTestId('note-pause').click()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('recording-return').click()
    await page.reload()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(toast).toHaveCount(0)
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-resume')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('note-resume').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(toast).toHaveCount(0)
    await page.getByTestId('note-stop').click()
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('recording-reminder-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Show a brief reminder when recording starts.')).toBeVisible()
    await toggle.click()
    await page.reload()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('nav-home').click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(toast).toHaveCount(0)
    await page.getByTestId('settings-open').click()
    await toggle.click()
    await page.getByTestId('recording-return').click()
    await expect(toast).toHaveCount(0)
    await page.getByTestId('note-stop').click()
    await page.getByTestId('nav-home').click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(toast).toBeVisible()
  } finally { await app.close() }
})
