import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('delete is centered over the whole workspace, traps focus safely and restores its opener on cancellation', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-delete-dialog-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings: (n: number) => unknown } }).__fake__.manyMeetings(1))
    await page.reload()
    // Delete forever lives in the Trash: every meeting goes there first
    await page.evaluate(async () => { for (const c of await window.yogurt.meetings.cards({ limit: 10 })) await window.yogurt.meetings.trash(c.id) })
    await page.getByTestId('nav-trash').click()
    const opener = page.getByTestId('trash-delete')
    const modal = page.getByTestId('delete-confirm')
    const cancel = page.getByTestId('delete-cancel')
    const yes = page.getByTestId('delete-yes')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const [width, height, colorScheme] of [[1100, 760, 'light'], [720, 520, 'dark']] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(width, height), [width, height])
      await page.emulateMedia({ colorScheme })
      await page.getByTestId('trash-row').first().hover()
      await opener.click()
      await expect(modal).toBeVisible()
      // Only the shell stretches; text and focus remain at their final geometry.
      await expect(modal).toHaveCSS('transform', 'none')
      await expect(modal.locator('.dialog-motion-content')).toHaveCSS('transform', 'none')
      await expect(modal.locator('.dialog-motion-content')).toHaveCSS('filter', 'none')
      const frames = await modal.locator('.dialog-motion-surface').evaluate(el => (el.getAnimations()[0]?.effect as KeyframeEffect)?.getKeyframes())
      expect(frames?.[1].transform).toMatch(/scale\(1\.008,\s*1\.018\)/)
      expect(frames?.[1].offset).toBe(0.72)
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      await expect.poll(async () => {
        const box = (await modal.boundingBox())!
        return Math.max(Math.abs(box.x + box.width / 2 - viewport.width / 2), Math.abs(box.y + box.height / 2 - viewport.height / 2))
      }).toBeLessThan(2)
      await expect(modal).toHaveAttribute('aria-modal', 'true')
      await expect(modal).toContainText('notes, transcript and recording are removed from this Mac for good')
      await expect(cancel).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(yes).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(cancel).toBeFocused()
      await page.keyboard.press('Meta+k')
      await expect(page.getByTestId('search')).toHaveCount(0)
      await page.keyboard.press('Meta+,')
      await expect(page.getByTestId('trash-page')).toBeVisible()
      await expect(modal).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
      await expect(opener).toBeFocused()
    }
    await page.getByTestId('trash-row').first().hover()
    await opener.click()
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(modal).toHaveCount(0)
    await expect(opener).toBeFocused()
    await page.getByTestId('trash-row').first().hover()
    await opener.click()
    await expect(cancel).toBeFocused()
    await page.mouse.click(10, 100)
    await expect(modal).toHaveCount(0)
    await expect(opener).toBeFocused()
    await expect(page.getByTestId('trash-row')).toHaveCount(1)

    // Dismissal cannot pretend to cancel a deletion already accepted by main.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('meetings:delete')
      ipcMain.handle('meetings:delete', () => new Promise((resolve) => setTimeout(() => resolve('failed'), 500)))
    })
    await page.getByTestId('trash-row').first().hover()
    await opener.click()
    await yes.click()
    await expect(yes).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.mouse.click(10, 100)
    await expect(modal).toBeVisible()
    await expect(modal).toContainText("Yogurt couldn't finish deleting this note. Try again.")
    await expect(yes).toBeEnabled()
    await cancel.click()
    await expect(opener).toBeFocused()

    // Search shares the same shell motion and keeps its input ready immediately.
    await page.keyboard.press('Meta+k')
    const search = page.getByTestId('search')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await expect(search).toHaveCSS('transform', 'none')
    await expect(search.locator('.dialog-motion-content')).toHaveCSS('transform', 'none')
    expect(await search.locator('.dialog-motion-surface').evaluate(el => el.getAnimations().length)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('trash-row').first().hover()
    await opener.click()
    await expect(cancel).toBeFocused()
    expect(await modal.locator('.dialog-motion-surface').evaluate(el => el.getAnimations().length)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
  } finally { await app.close() }
})
