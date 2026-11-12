import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const theme of ['light', 'dark'] as const) test(`sidebar pane morph keeps its frame fixed in ${theme}`, async ({}, info) => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-pane-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData,
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
    const button = page.locator('.workspace-sidebar-toggle'), svg = button.locator('svg')
    const frame = svg.locator('rect').first(), pane = svg.locator('.sidebar-toggle-pane')
    const original = await frame.boundingBox()
    await page.mouse.move(600, 80)
    await button.screenshot({ path: info.outputPath(`toggle-${theme}-rest.png`) })
    await button.hover()
    await expect(pane).toHaveCSS('animation-name', 'none')
    await expect(pane).toHaveCSS('width', '6px')
    expect(await frame.boundingBox()).toEqual(original)
    await expect(svg).toHaveCSS('transform', 'none')
    await button.screenshot({ path: info.outputPath(`toggle-${theme}-hover.png`) })
    await button.click()
    await page.mouse.move(600, 80)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(pane).toHaveCSS('width', '2px')
    await button.screenshot({ path: info.outputPath(`toggle-${theme}-collapsed.png`) })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await button.click()
    await expect(pane).toHaveCSS('width', '6px')
    await expect(pane).toHaveCSS('animation-name', 'none')
    await expect(pane).toHaveCSS('transition-duration', '0s')
    await page.keyboard.press('Control+Meta+s')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(pane).toHaveCSS('width', '2px')
  } finally { await app.close() }
})
