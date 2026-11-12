import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-feedback-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('first reads have skeletons; a loaded transcript stays mounted across tabs', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    const startX = (await page.getByTestId('workspace-heading').boundingBox())!.x
    const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(40))
    await app.evaluate(({ ipcMain }) => {
      for (const channel of ['meetings:cards', 'meetings:trashed', 'meetings:get', 'notes:get', 'transcript:get', 'settings:get', 'permissions:status', 'conversations:list', 'conversations:get']) {
        const old = (ipcMain as any)._invokeHandlers.get(channel)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (...args) => { await new Promise(resolve => setTimeout(resolve, 650)); return old(...args) })
      }
    })
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-loading')).toBeVisible()
    await expect(page.getByTestId('settings-heading')).toBeVisible()
    await expect(page.getByTestId('login-toggle')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('settings-loading.png') })
    await expect(page.getByTestId('settings-loading')).toHaveCount(0)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('meetings-loading')).toBeVisible()
    await expect(page.getByTestId('new-note')).toBeVisible()
    expect((await page.getByTestId('workspace-heading').boundingBox())!.x).toBe(startX)
    await expect(page.getByTestId('meetings-loading')).toHaveCount(0)
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('meetings-loading')).toBeVisible()
    await expect(page.getByTestId('trash-none')).toHaveCount(0)
    await expect(page.getByTestId('trash-none')).toBeVisible()
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-loading')).toBeVisible()
    await expect(page.getByTestId('chat-loading')).toHaveCount(0)
    await expect(page.getByTestId('chat-recent-list')).toHaveCount(0)
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await expect(page.getByTestId('note-loading')).toBeVisible()
    // Like the real note, the header pads under the toolbar, so its title row must sit below it.
    expect((await page.locator('.loading-note .note-title-type').boundingBox())!.y).toBeGreaterThan((await page.locator('.workspace-toolbar').boundingBox())!.height)
    await page.screenshot({ path: testInfo.outputPath('note-loading.png') })
    await expect(page.getByTestId('note-transcript-toggle')).toBeVisible()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-loading')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('transcript-loading.png') })
    await expect(page.getByTestId('transcript-empty')).toHaveCount(0)
    await expect(page.getByTestId('transcript-line')).toHaveCount(40)
    await page.getByTestId('transcript').evaluate(el => { (el as any).__loadedOnce = true })
    await page.getByTestId('note-notes-tab').click()
    await page.getByTestId('note-transcript-toggle').click()
    expect(await page.getByTestId('transcript').evaluate(el => (el as any).__loadedOnce)).toBe(true)
    await expect(page.getByTestId('transcript-loading')).toHaveCount(0)
    await expect(page.getByTestId('transcript-line').first()).toBeVisible()
  } finally { await app.close() }
})

test('toast yields to Ask Yogurt and returns without replacing its Undo action', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed())!.setSize(1280, 900))
    const ids = await app.evaluate(() => [(globalThis as any).__fake__.bigMeeting(4), (globalThis as any).__fake__.bigMeeting(6)])
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), ids[0])
    await expect(page.getByTestId('chat-open')).toBeVisible()
    // Use the same public UI action so the real Undo toast and timer are exercised.
    await page.getByTestId('nav-home').click()
    await page.evaluate(id => window.yogurt.meetings.rename(id, 'Toast test removal'), ids[1])
    const removal = page.locator('.native-meeting-row').filter({ hasText: 'Toast test removal' })
    await removal.hover()
    await removal.getByTestId('past-note-more').click()
    await page.getByTestId('past-note-trash').click()
    await expect(page.getByTestId('trash-toast')).toBeVisible()
    await page.getByTestId('nav-chat').click()
    await expect.poll(async () => {
      const toast = await page.getByTestId('trash-toast').boundingBox(), composer = await page.getByTestId('chat-page-box').boundingBox()
      return !!toast && !!composer && composer.y + composer.height < toast.y
    }).toBe(true)
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), ids[0])
    const toast = page.getByTestId('trash-toast')
    await toast.hover()
    await page.screenshot({ path: testInfo.outputPath('toast-closed.png') })
    const before = await toast.boundingBox()
    await page.getByTestId('chat-open').click()
    await expect.poll(async () => {
      const a = await toast.boundingBox(), b = await page.getByTestId('chat-panel').boundingBox()
      return !!a && !!b && a.x + a.width + 10 <= b.x
    }).toBe(true)
    await toast.hover()
    await page.locator('.chat-morph-surface').evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: testInfo.outputPath('toast-beside-chat.png') })
    await page.getByTestId('chat-close').click()
    await expect.poll(async () => Math.abs((await toast.boundingBox())!.x - before!.x)).toBeLessThan(2)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed())!.setSize(820, 740))
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('aria-modal', 'true')
    await expect.poll(async () => {
      const a = await toast.boundingBox(), b = await page.getByTestId('chat-panel').boundingBox()
      return !!a && !!b && b.y + b.height + 8 <= a.y
    }).toBe(true)
    await page.locator('.chat-morph-surface').evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)))
    await page.screenshot({ path: testInfo.outputPath('toast-narrow-chat.png') })
    await page.getByTestId('trash-undo').click()
    await expect(toast).toHaveCount(0)
  } finally { await app.close() }
})
