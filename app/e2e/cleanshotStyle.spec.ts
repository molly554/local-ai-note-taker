import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the primary action stays accented in both themes and compact confirmation keeps safe focus', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-style-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(3))
    await page.reload()
    for (const colorScheme of ['light', 'dark'] as const) {
      // the window gets narrow and the sidebar folds away: go by route
      await page.evaluate(() => window.yogurt.nav.go(''))
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
      const primary = page.getByTestId('new-note')
      await expect(primary).toBeVisible()
      expect(await primary.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')
      expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await expect(page.getByTestId('past-note').first()).toBeVisible()
      // the one confirmation left: Delete forever, in the Trash
      await page.evaluate(async () => { const [c] = await window.yogurt.meetings.cards({ limit: 1 }); await window.yogurt.meetings.trash(c.id) })
      await page.evaluate(() => window.yogurt.nav.go('/trash'))
      const opener = page.getByTestId('trash-delete').first()
      await page.getByTestId('trash-row').first().hover()
      await opener.click()
      const modal = page.getByTestId('delete-confirm')
      const box = (await modal.boundingBox())!
      expect(box.width).toBeLessThanOrEqual(360)
      const cancel = page.getByTestId('delete-cancel')
      const yes = page.getByTestId('delete-yes')
      await expect(cancel).toBeFocused()
      expect((await yes.boundingBox())!.y).toBeLessThan((await cancel.boundingBox())!.y)
      await page.keyboard.press('Escape')
      await expect(opener).toBeFocused()
      // Shortcuts wait while a dialog is still closing, so open search once it has gone.
      await expect(modal).toHaveCount(0)
      await page.keyboard.press('Meta+k')
      await expect(page.getByTestId('search-input')).toBeFocused()
      const search = (await page.getByTestId('search').boundingBox())!
      expect(search.x).toBeGreaterThanOrEqual(0)
      expect(search.x + search.width).toBeLessThanOrEqual(720)
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  } finally { await app.close() }
})
