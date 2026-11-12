import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CI only: no local Electron launch or visual gallery.
test('scrollbars share idle/active styling and agenda reaches its column edge', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-scroll-')) } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as any).__fake__.manyMeetings({ n: 80, clean: true }))
    await page.reload()
    const library = page.locator('.native-library'), agenda = page.locator('.agenda-scroll')
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    await page.mouse.move(0, 0)
    await page.getByTestId('search-open').focus()
    await expect(library).toHaveCSS('scrollbar-color', 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')
    await library.evaluate(el => { el.scrollTop = 100 })
    await expect(library).toHaveAttribute('data-scrolling', '')
    await expect(library).not.toHaveAttribute('data-scrolling', '', { timeout: 3000 })
    // The library keeps its gutter so rows don't shift when the scrollbar appears.
    await expect(library).toHaveCSS('scrollbar-gutter', 'stable')
    await expect(agenda).toHaveCSS('scrollbar-width', 'thin')
    expect(await agenda.evaluate(el => Math.abs(el.getBoundingClientRect().right - el.closest('.native-agenda')!.getBoundingClientRect().right))).toBeLessThanOrEqual(1)
    await library.hover()
    await expect(library).not.toHaveCSS('scrollbar-color', 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)')
    await page.emulateMedia({ contrast: 'more' })
    await expect(library).toHaveCSS('scrollbar-color', 'auto')
  } finally { await app.close() }
})
