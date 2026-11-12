import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const theme of ['light', 'dark'] as const) test(`folder labels leave the meeting identity alone and yield in a narrow window (${theme})`, async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: unknown): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.evaluate(async theme => {
      await window.yogurt.settings.setTheme(theme)
      const [meeting] = await window.yogurt.meetings.cards({ limit: 1 })
      for (const [name, color] of [['Customers', 'violet'], ['Fundraise', 'amber']] as const) {
        const folder = await window.yogurt.folders.create(name, { icon: 'star', color })
        if (!folder) throw new Error('Could not create fixture folder')
        await window.yogurt.folders.add(folder.id, meeting.id)
      }
    }, theme)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setContentSize(1280, 800))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280)
    await page.reload()
    const row = page.getByTestId('past-note'), pills = row.getByTestId('past-note-folder')
    await expect(pills).toHaveText(['Customers', 'Fundraise'])
    await expect(pills.first()).toBeVisible()
    await expect(pills.first()).toHaveCSS('height', '22px')
    await expect(pills.first()).toHaveCSS('font-size', '11px')
    await expect(pills.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(pills.first().locator('.meeting-folder-dot')).toHaveCSS('width', '7px')
    await expect(row.locator('.meeting-identity[data-folder-color], .meeting-identity .folder-glyph')).toHaveCount(0)
    const drag = page.evaluate(() => new Promise<{ text: string | null; folderTile: boolean; identity: boolean }>(resolve => {
      const original = DataTransfer.prototype.setDragImage
      DataTransfer.prototype.setDragImage = function (el, x, y) {
        resolve({ text: el.textContent, folderTile: !!el.querySelector('[data-folder-color]'), identity: !!el.querySelector('.meeting-identity') })
        DataTransfer.prototype.setDragImage = original
        original.call(this, el, x, y)
      }
    }))
    await row.dragTo(page.getByTestId('sidebar-folder-open').filter({ hasText: 'Customers' }))
    expect(await drag).toEqual({ text: 'Budget review', folderTile: false, identity: true })
    await pills.last().click()
    await expect(page.getByTestId('sidebar-folder-open').filter({ hasText: 'Fundraise' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('past-note-folder')).toHaveCount(0)
    await page.getByTestId('nav-home').click()
    await expect(pills).toHaveCount(2)
    await page.getByTestId('sidebar-folder-open').filter({ hasText: 'Customers' }).click()
    await expect(page.getByTestId('past-note-folder')).toHaveCount(0)
    await expect(row.locator('.meeting-identity[data-folder-color], .meeting-identity .folder-glyph')).toHaveCount(0)
    await page.getByTestId('nav-home').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setContentSize(720, 520))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await expect(row.getByTestId('past-note-folders')).toBeVisible()
    await expect(pills).toHaveCount(2)
    await expect(pills.first()).toHaveCSS('width', '22px')
    await expect(pills.first()).toHaveAttribute('title', 'Customers')
    expect((await pills.last().boundingBox())!.x + (await pills.last().boundingBox())!.width).toBeLessThanOrEqual((await row.getByTestId('past-note-folders').boundingBox())!.x + (await row.getByTestId('past-note-folders').boundingBox())!.width)
    await expect(pills.first().locator('.meeting-folder-name')).toHaveCSS('clip-path', 'inset(50%)')
    const dimensions = await row.evaluate(el => {
      const title = el.querySelector('.meeting-description strong')!, box = title.getBoundingClientRect(), row = el.getBoundingClientRect()
      return { title: box.width, within: box.right <= row.right, scroll: el.scrollWidth, width: el.clientWidth }
    })
    expect(dimensions.title).toBeGreaterThan(100)
    expect(dimensions.within).toBe(true)
    expect(dimensions.scroll).toBe(dimensions.width)
  } finally { await app.close() }
})
