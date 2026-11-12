import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-start-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
async function folderPage(page: Page) {
  const folder = await page.evaluate(async () => {
    const folder = (await window.yogurt.folders.create('Therapy'))!
    window.yogurt.nav.go(`/folder/${folder.id}`)
    return folder
  })
  await expect(page.getByTestId('folder-title')).toHaveText('Therapy')
  return folder
}
const meetingId = (page: Page) => page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
const foldersOf = (page: Page, id: string) => page.evaluate(id => window.yogurt.folders.of(id), id)
const stop = async (page: Page) => {
  await page.getByTestId('note-stop').click()
  await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
}

test('a folder starts recording immediately and only files the note after a successful confirmation', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    await expect(page.getByTestId('folder-empty')).toContainText('Start recording here')
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await meetingId(page)
    const proposal = page.getByTestId('folder-suggestion')
    await expect(proposal).toContainText('Add to Therapy?')
    expect(await foldersOf(page, id)).toEqual([])
    // The recording reminder is a nonmodal toast, not a folder confirmation.
    await expect(page.locator('[role="dialog"]').filter({ hasNot: page.getByText("Let everyone know you're recording.", { exact: true }) })).toHaveCount(0)

    // Navigating away does not silently accept or lose the pending choice.
    await page.getByTestId('nav-home').click()
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await expect(proposal).toBeVisible()
    expect(await foldersOf(page, id)).toEqual([])
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const add = handlers.get('folders:add')!
      let failed = false
      ipcMain.removeHandler('folders:add')
      ipcMain.handle('folders:add', (...args) => {
        if (!failed) { failed = true; throw new Error('fixture write failed') }
        return add(...args)
      })
    })
    await page.getByTestId('folder-suggestion-confirm').click()
    await expect(page.getByTestId('folder-suggestion-error')).toBeVisible()
    await expect(proposal).toBeVisible()
    expect(await foldersOf(page, id)).toEqual([])
    await page.getByTestId('folder-suggestion-confirm').click()
    await expect(proposal).toHaveCount(0)
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Therapy')
    expect(await foldersOf(page, id)).toMatchObject([{ id: folder.id }])
    await stop(page)
  } finally { await app.close() }
})

test('cancelling the folder suggestion leaves the recording unfiled; Meetings and Chat suggest no folder', async () => {
  const { app, page } = await launch()
  try {
    await folderPage(page)
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('folder-suggestion')).toBeVisible()
    const id = await meetingId(page)
    await page.getByTestId('folder-suggestion-cancel').click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')
    await expect(page.getByTestId('note-folders')).toBeFocused()
    expect(await foldersOf(page, id)).toEqual([])
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await stop(page)

    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    await stop(page)

    await page.getByTestId('nav-chat').click()
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    expect(await foldersOf(page, await meetingId(page))).toEqual([])
    await stop(page)
    await page.getByTestId('nav-chat').click()
    const chat = await page.evaluate(() => window.yogurt.conversations.ask(null, 'What was discussed?'))
    await page.evaluate(id => window.yogurt.nav.go(`/chat/${id}`), chat)
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(page.getByTestId('start-recording')).toHaveCount(0)
  } finally { await app.close() }
})

test('a failed folder start stays on the folder with no membership or pending suggestion', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('meetings:start')
      ipcMain.handle('meetings:start', () => ({ error: 'failed' }))
    })
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('start-recording-message')).toBeVisible()
    await expect(page.getByTestId('start-recording')).toBeEnabled()
    await expect(page.getByTestId('folder-page')).toBeVisible()
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    expect(await page.evaluate(id => window.yogurt.meetings.cards({ folder: id, limit: 10 }), folder.id)).toEqual([])
  } finally { await app.close() }
})

test('an active recording replaces start actions and a raced start identifies the existing note', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    // A second entry point wins the race after this button was shown but before its request reaches main.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const start = handlers.get('meetings:start')!
      ipcMain.removeHandler('meetings:start')
      ipcMain.handle('meetings:start', async (...args) => { await start(...args); return start(...args) })
    })
    await page.getByTestId('start-recording').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await meetingId(page)
    const reused = await page.evaluate(() => window.yogurt.meetings.start(null))
    expect(reused).toEqual({ id, alreadyRecording: true })
    await expect(page.getByTestId('folder-suggestion')).toHaveCount(0)
    for (const route of [`/folder/${folder.id}`, '/chat']) {
      await page.evaluate(route => window.yogurt.nav.go(route), route)
      await expect(page.getByTestId('recording-return')).toBeVisible()
      await expect(page.getByTestId('start-recording')).toHaveCount(0)
    }
    expect(await foldersOf(page, id)).toEqual([])
    await page.getByTestId('recording-return').click()
    await stop(page)
  } finally { await app.close() }
})

test('localized recording actions leave room for a long folder title at the smallest window width', async () => {
  const { app, page } = await launch()
  try {
    const folder = await folderPage(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await page.evaluate(id => window.yogurt.folders.rename(id, 'Therapy and personal reflections '.repeat(6)), folder.id)
    await expect(page.getByTestId('folder-title')).toHaveText('Therapy and personal reflections '.repeat(6).trim())
    for (const locale of ['en', 'de', 'ar']) {
      await page.evaluate(locale => window.yogurt.settings.setLanguage(locale), locale)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      const action = page.getByTestId('start-recording')
      await expect(action).toBeVisible()
      await expect.poll(async () => {
        const heading = (await page.getByTestId('workspace-heading').boundingBox())!
        const button = (await action.boundingBox())!
        return locale === 'ar' ? heading.x - (button.x + button.width) : button.x - (heading.x + heading.width)
      }).toBeGreaterThanOrEqual(12)
      const button = (await action.boundingBox())!
      expect(button.x).toBeGreaterThanOrEqual(locale === 'ar' ? 132 : 0)
      expect(button.x + button.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
      await expect(action).toBeEnabled()
    }
  } finally { await app.close() }
})
