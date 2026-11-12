import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NoteView } from '../src/shared/types'

for (const theme of ['light', 'dark'] as const) for (const width of [420, 860]) {
  test(`summary frame follows writing and yields to reading at ${width}px in ${theme}`, async () => {
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_FAKE: '1', YOGURT_BACKGROUND: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-summary-rim-')),
    } })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      const win = await app.browserWindow(page)
      await win.evaluate(w => w.setContentSize(1200, 850))
      const id = await app.evaluate(async () => (await (globalThis as unknown as { __fake__: { chatMeetings(): Promise<string[]> } }).__fake__.chatMeetings())[0])
      await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
      await page.getByTestId('note-summary-tab').click()
      await page.locator('.note-layout').evaluate((el, width) => { el.style.flex = 'none'; el.style.width = `${width}px` }, width)
      const base = await page.evaluate(id => window.yogurt.notes.get(id), id)
      const push = async (status: NoteView['status'], draft: string) => {
        const view = { ...base, status, draft, ...(status === 'done' ? { enhanced: draft } : {}) }
        await app.evaluate(({ BrowserWindow }, view) => {
          BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.webContents.send('notes:changed', view)
        }, view)
      }
      const rim = page.getByTestId('note-summary-rim'), pane = page.locator('#note-notes-panel'), latest = page.getByTestId('note-summary-latest')
      await push('waiting', '')
      await expect(rim).toHaveCSS('opacity', '1')
      await expect(page.getByTestId('note-enhanced-waiting')).toBeVisible()
      expect(await pane.evaluate(el => el.scrollTop)).toBe(0)
      const text = (n: number) => Array.from({ length: n }, (_, i) => `## Section ${i + 1}\nThe team agreed to review the launch notes and confirm the next step before publishing.\n`).join('\n')
      await push('writing', text(18))
      await expect(page.getByTestId('note-enhanced-editor')).toContainText('Section 18')
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(24)
      await expect(rim).toHaveCSS('opacity', '1')
      await page.getByTestId('note-transcript-toggle').click()
      await expect(page.locator('.note-reading-frame')).toBeHidden()
      expect(await rim.evaluate(el => getComputedStyle(el, '::before').animationPlayState)).toBe('paused')
      await page.getByTestId('note-summary-tab').click()
      await expect(page.locator('.note-reading-frame')).toHaveAttribute('data-active', 'true')
      await pane.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); el.scrollTop = 100 })
      await expect(latest).toBeVisible()
      await push('writing', text(22))
      await expect(page.getByTestId('note-enhanced-editor')).toContainText('Section 22')
      expect(await pane.evaluate(el => el.scrollTop)).toBeCloseTo(100, 0)
      await latest.click()
      await expect(latest).toBeHidden()
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(24)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await rim.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none')
      await expect(rim).toHaveCSS('opacity', '1')
      const before = await pane.boundingBox(), scrollTop = await pane.evaluate(el => el.scrollTop)
      await push('done', text(22))
      await expect(rim).toHaveCSS('opacity', '0')
      await expect(latest).toBeHidden()
      expect(await pane.boundingBox()).toEqual(before)
      expect(await pane.evaluate(el => el.scrollTop)).toBeCloseTo(scrollTop, 0)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      expect(await rim.evaluate(el => getComputedStyle(el, '::before').animationPlayState)).toBe('paused')
      await expect(page.getByTestId('note-summary-tab')).toHaveText('Summary')
      expect(await page.getByTestId('note-summary-tab').locator('svg').count()).toBe(1)
      await expect(page.locator('.note-reading-clip')).toHaveCSS('overflow', 'hidden')
      await expect(page.locator('.note-reading-clip')).toHaveCSS('border-radius', '10px')
    } finally { await app.close() }
  })
}
