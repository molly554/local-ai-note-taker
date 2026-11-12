import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch() {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-call-controls-')) } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('paused recording controls fit the minimum window and keep focus inside each button', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 520))
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('rec-mic')).toHaveText('Recording paused')
    await page.keyboard.press('Tab')
    await page.getByTestId('note-pause').focus()
    await page.screenshot({ path: testInfo.outputPath('paused-minimum.png') })
    await expect(page.getByTestId('rec-mic-chip').locator('[data-icon=Pause]')).toHaveAttribute('fill', 'currentColor')
    await expect(page.getByTestId('note-pause')).toHaveCSS('outline-offset', '-2px')
    const group = page.locator('.note-recording-group')
    const buttons = page.locator('.note-recording-group button')
    const box = await group.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(720)
    expect(box!.height).toBe(30)
    await expect(buttons).toHaveCount(2)
    await expect(page.getByTestId('note-pause')).toHaveText('')
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('note-stop')).toBeFocused()
    await expect(page.getByTestId('note-stop')).toHaveCSS('background-color', 'rgb(111, 0, 255)')
    await expect(page.getByTestId('note-stop').locator('svg')).toHaveCount(0)
    for (const button of await buttons.all()) {
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await expect(page.getByTestId('note-stop')).toHaveText('Finish')
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'false')
    await expect(page.getByTestId('note-wave')).toBeVisible()
    await expect(group).not.toContainText('Recording')
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'done', { timeout: 20000 })
  } finally { await app.close() }
})

test('Personal jargon has the same visible unfocused field boundary in light and dark mode', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
      const input = page.getByTestId('jargon-input')
      await input.evaluate(el => el.blur())
      await input.scrollIntoViewIfNeeded()
      const row = page.locator('.settings-row').filter({ has: input })
      await row.screenshot({ path: testInfo.outputPath(`jargon-${theme}.png`) })
      const field = page.getByTestId('jargon-field')
      await expect(field).toHaveCSS('border-top-width', '1px')
      await expect(field).toHaveCSS('border-top-style', 'solid')
      const nameStyle = await page.getByTestId('settings-name').evaluate(el => ({ border: getComputedStyle(el).borderTopColor, bg: getComputedStyle(el).backgroundColor }))
      await expect(field).toHaveCSS('border-top-color', nameStyle.border)
      await expect(field).toHaveCSS('background-color', nameStyle.bg)
      await input.fill(`Example ${theme}`)
      await input.press('Enter')
      await expect(page.getByTestId('jargon-chip').filter({ hasText: `Example ${theme}` })).toBeVisible()
    }
  } finally { await app.close() }
})
