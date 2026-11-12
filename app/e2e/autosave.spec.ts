import { selectNoteVersion } from './noteVersion'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-autosave-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
  await page.reload()
  await page.getByTestId('past-note').click()
  await expect(page.getByTestId('note-enhanced')).toBeVisible()
  const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
  const db = new DatabaseSync(join(userData, 'yogurt.db'))
  return { app, page, db, id }
}
const failWrites = (db: DatabaseSync) => db.exec("CREATE TRIGGER test_note_write_failure BEFORE INSERT ON notes BEGIN SELECT RAISE(FAIL, 'test note write failure'); END")
const recoverWrites = (db: DatabaseSync) => db.exec('DROP TRIGGER IF EXISTS test_note_write_failure')
const copyCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __copyCalls: number }).__copyCalls)

test('failed My notes saves retain exact text across navigation and reload; Copy waits for successful retry', async () => {
  const { app, page, db, id } = await launch()
  try {
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as unknown as { __copyCalls: number }).__copyCalls = 0
      ipcMain.removeHandler('share:copy')
      ipcMain.handle('share:copy', () => { (globalThis as unknown as { __copyCalls: number }).__copyCalls++; return 'copied' })
    })
    await selectNoteVersion(page, 'mine')
    await page.getByTestId('note-mine').fill('Earlier saved version')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    failWrites(db)
    const latest = 'The latest exact change must survive a failed write.'
    await page.getByTestId('note-mine').fill(latest)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('note-save-warning')).toBeVisible()
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('note-save-status')).not.toContainText('Lynote NoteTaker can make mistakes.')
    await expect(page.getByTestId('note-mine')).toBeFocused()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await expect(page.getByTestId('note-mine')).toBeInViewport()
    const warning = (await page.getByTestId('note-save-status').boundingBox())!
    const toolbar = (await page.getByTestId('note-bar').boundingBox())!
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(warning.y)
    expect(warning.x).toBeGreaterThanOrEqual(0)
    expect(warning.x + warning.width).toBeLessThanOrEqual(720)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    // measured where it comes to rest, not while it slides in
    await page.getByTestId('transcript-panel').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const transcript = (await page.getByTestId('transcript-panel').boundingBox())!
    expect(transcript.y).toBeGreaterThanOrEqual(40)
    // Sidebar collapse can rewrap the warning after resize; compare both live bounds together.
    await expect.poll(() => page.getByTestId('transcript-panel').evaluate(el => {
      const warning = document.querySelector('[data-testid="note-save-status"]')!.getBoundingClientRect()
      return el.getBoundingClientRect().bottom - warning.top
    })).toBeLessThanOrEqual(0)
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('note-mine')).toHaveText(latest)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('What was decided?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.getByTestId('chat-panel').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const chat = (await page.getByTestId('chat-panel').boundingBox())!
    expect(chat.y).toBeGreaterThanOrEqual(0)
    expect(chat.y + chat.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('note-save-retry')).toBeInViewport()
    expect(db.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ mine: 'Earlier saved version' })
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-notes').click()
    await expect(page.getByTestId('share-said')).toContainText("Couldn't save your latest changes")
    expect(await copyCalls(app)).toBe(0)
    // The minimum window collapses navigation; use its visible toggle first.
    await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('past-note').click()
    await selectNoteVersion(page, 'mine')
    await expect(page.getByTestId('note-mine')).toHaveText(latest)
    await page.reload()
    await selectNoteVersion(page, 'mine')
    await expect(page.getByTestId('note-mine')).toHaveText(latest)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    recoverWrites(db)
    await page.getByTestId('note-save-retry').click()
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    await expect(page.getByTestId('note-save-warning')).toHaveCount(0)
    expect(db.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ mine: latest })
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-notes').click()
    await expect(page.getByTestId('share-said')).toContainText('Copied')
    expect(await copyCalls(app)).toBe(1)
  } finally { recoverWrites(db); db.close(); await app.close() }
})

test('failed Enhanced edits survive reopening and become edited saved notes after retry', async () => {
  const { app, page, db, id } = await launch()
  try {
    const original = db.prepare('SELECT enhanced FROM notes WHERE meeting_id = ?').get(id)
    failWrites(db)
    const latest = 'My corrected enhanced notes, with the exact decision.'
    await page.getByTestId('note-enhanced-editor').fill(latest)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').click()
    await expect(page.getByTestId('note-enhanced')).toHaveText(latest)
    expect(db.prepare('SELECT enhanced FROM notes WHERE meeting_id = ?').get(id)).toEqual(original)
    recoverWrites(db)
    await page.getByTestId('note-save-retry').click()
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    // Filling the first heading retains its rich-text heading format in Markdown.
    expect(db.prepare('SELECT enhanced, edited FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ enhanced: `## ${latest}`, edited: 1 })
  } finally { recoverWrites(db); db.close(); await app.close() }
})

test('closing retains the renderer and last keystroke; failed quit returns to notes unless discard is explicitly chosen', async () => {
  const { app, page, db } = await launch()
  let closed = false
  app.on('close', () => { closed = true })
  try {
    await selectNoteVersion(page, 'mine')
    failWrites(db)
    const latest = 'This last keystroke closes before the debounce timer.'
    await page.getByTestId('note-mine').fill(latest)
    const windowId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!
      window.close()
      return window.id
    })
    expect(page.isClosed()).toBe(false)
    expect(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible(), windowId)).toBe(false)
    await app.evaluate(() => (globalThis as unknown as { __fake__: { trayClick(id: string): void } }).__fake__.trayClick('open'))
    const reopened = page
    expect(await app.evaluate(({ BrowserWindow }, id) => !!BrowserWindow.fromId(id), windowId)).toBe(true)
    await expect(reopened.getByTestId('note-mine')).toHaveText(latest)
    await expect(reopened.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { __quitChoice: number; __quitDialogs: number }
      state.__quitChoice = 0; state.__quitDialogs = 0
      dialog.showMessageBox = async () => { state.__quitDialogs++; return { response: state.__quitChoice, checkboxChecked: false } }
    })
    await app.evaluate(({ app }) => app.quit())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __quitDialogs: number }).__quitDialogs)).toBe(1)
    await expect.poll(() => reopened.evaluate(() => document.body.inert)).toBe(false)
    await expect(reopened.getByTestId('note-mine')).toHaveText(latest)
    await expect(reopened.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await app.evaluate(() => { (globalThis as unknown as { __quitChoice: number }).__quitChoice = 1 })
    const quitting = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await quitting
    expect(closed).toBe(true)
  } finally { recoverWrites(db); db.close(); if (!closed) await app.close() }
})

test('backup refuses unsaved text without replacing the previous archive; retry exports the exact latest note', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'yogurt-autosave-backup-')), 'backup.zip')
  const { app, page, db, id } = await launch({ YOGURT_BACKUP_PATH: out })
  try {
    await selectNoteVersion(page, 'mine')
    await page.getByTestId('note-mine').fill('Saved before the failed edit')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    expect((await page.evaluate(() => window.yogurt.backup.export())).ok).toBe(true)
    const original = readFileSync(out)
    failWrites(db)
    const latest = 'Exact latest text included only after successful save.'
    await page.getByTestId('note-mine').fill(latest)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await page.keyboard.press('Meta+,')
    await page.getByTestId('backup-export').click()
    await expect(page.getByTestId('backup-said')).toContainText('Save your latest note changes before exporting a backup.')
    expect(readFileSync(out)).toEqual(original)
    await page.getByTestId('backup-open-note').click()
    // The failed side is visible immediately; no need to discover it behind Enhanced.
    await expect(page.getByTestId('note-mine')).toHaveText(latest)
    recoverWrites(db)
    await page.keyboard.press('Meta+,')
    await page.getByTestId('backup-export').click()
    await expect(page.getByTestId('backup-said')).toContainText('Exported 1 meeting')
    const unpacked = mkdtempSync(join(tmpdir(), 'yogurt-autosave-unpacked-'))
    execFileSync('/usr/bin/ditto', ['-x', '-k', out, unpacked])
    const snapshot = new DatabaseSync(join(unpacked, 'yogurt.db'), { readOnly: true })
    try { expect(snapshot.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ mine: latest }) }
    finally { snapshot.close() }
  } finally { recoverWrites(db); db.close(); await app.close() }
})

test('a final unload handoff veto restores interactivity and the next quit protects unsaved edits again', async () => {
  const { app, page, db, id } = await launch()
  let closed = false
  app.on('close', () => { closed = true })
  try {
    await page.evaluate(() => window.yogurt.meetings.start(null))
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const recordingId = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await app.evaluate(({ ipcMain, dialog }) => {
      const state = globalThis as unknown as { __quitChoice: number; __quitDialogs: number; __vetoes: number }
      state.__quitChoice = 0; state.__quitDialogs = 0; state.__vetoes = 0
      dialog.showMessageBox = async () => { state.__quitDialogs++; return { response: state.__quitChoice, checkboxChecked: false } }
      // Reproduce an unavailable final synchronous handoff, after the normal async flush.
      ipcMain.removeAllListeners('notes:flush-sync')
      ipcMain.on('notes:flush-sync', (e, _id, _side, _md, revision) => { state.__vetoes++; e.returnValue = { revision, status: 'failed', retained: false } })
    })
    await page.evaluate((id) => {
      window.addEventListener('beforeunload', (e) => {
        const result = window.yogurt.notes.flushSync(id, 'mine', 'Final handoff transport probe', 99)
        if (result.status !== 'saved' && !result.retained) { e.preventDefault(); e.returnValue = '' }
      })
    }, id)
    await app.evaluate(({ app }) => app.quit())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __vetoes: number }).__vetoes)).toBe(1)
    await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(false)
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    const stopped = db.prepare('SELECT state, ended_at FROM meetings WHERE id = ?').get(recordingId)!
    expect(['stopped', 'done']).toContain(stopped.state)
    expect(stopped.ended_at).toEqual(expect.any(Number))
    // A resumed app can start a fresh recording: the active meeting was cleared along with capture.
    await page.evaluate(() => window.yogurt.meetings.start(null))
    const nextId = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    expect(nextId).not.toBe(recordingId)
    await page.evaluate((id) => window.yogurt.meetings.stop(id), nextId)
    await page.evaluate((id) => window.yogurt.nav.go(`/note/${id}`), id)
    await selectNoteVersion(page, 'mine')
    failWrites(db)
    await page.getByTestId('note-mine').fill('The next quit must still protect this edit')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await app.evaluate(({ app }) => app.quit())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __quitDialogs: number }).__quitDialogs)).toBe(1)
    await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(false)
    await expect(page.getByTestId('note-mine')).toHaveText('The next quit must still protect this edit')
    await app.evaluate(() => { (globalThis as unknown as { __quitChoice: number }).__quitChoice = 1 })
    const quitting = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await quitting
  } finally {
    recoverWrites(db); db.close()
    if (!closed) {
      // A failed assertion must not leave this test's deliberate unload veto blocking cleanup.
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await app.close()
    }
  }
})

test('an older save view arriving during new typing cannot replace the visible editor or acknowledge that newer edit', async () => {
  const { app, page, db, id } = await launch()
  try {
    await selectNoteVersion(page, 'mine')
    await page.getByTestId('note-mine').fill('Saved older text')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    const older = await page.evaluate((id) => window.yogurt.notes.get(id), id)
    await page.getByTestId('note-mine').fill('Newer visible text')
    await app.evaluate(({ BrowserWindow }, view) => {
      BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.webContents.send('notes:changed', view)
    }, older)
    await expect(page.getByTestId('note-mine')).toHaveText('Newer visible text')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    expect(db.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ mine: 'Newer visible text' })
  } finally { db.close(); await app.close() }
})

test('backup flushes a renderer-only draft after transport failure before invoking the export handler', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'yogurt-transport-backup-')), 'backup.zip')
  const { app, page, db, id } = await launch({ YOGURT_BACKUP_PATH: out })
  try {
    expect((await page.evaluate(() => window.yogurt.backup.export())).ok).toBe(true)
    const original = readFileSync(out), stored = db.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)
    await app.evaluate(({ ipcMain }) => {
      // Test-only wrappers around the actual pinned Electron handlers preserve the real recovery path.
      type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers
      const save = handlers.get('notes:set-mine')!, backup = handlers.get('backup:export')!
      const sync = ipcMain.listeners('notes:flush-sync')
      const state = globalThis as unknown as { __transportDown: boolean; __backupCalls: number; __recoverTransport(): void }
      state.__transportDown = true; state.__backupCalls = 0
      ipcMain.removeHandler('notes:set-mine')
      ipcMain.handle('notes:set-mine', (...args) => { if (state.__transportDown) throw new Error('test transport unavailable'); return save(...args) })
      ipcMain.removeHandler('backup:export')
      ipcMain.handle('backup:export', (...args) => { state.__backupCalls++; return backup(...args) })
      ipcMain.removeAllListeners('notes:flush-sync')
      ipcMain.on('notes:flush-sync', (e, _id, _side, _text, revision) => { e.returnValue = { revision, status: 'failed', retained: false } })
      state.__recoverTransport = () => {
        state.__transportDown = false
        ipcMain.removeAllListeners('notes:flush-sync')
        for (const listener of sync) ipcMain.on('notes:flush-sync', listener as (...args: unknown[]) => void)
      }
    })
    await selectNoteVersion(page, 'mine')
    const latest = 'The renderer-only draft must reach main before backup.'
    await page.getByTestId('note-mine').fill(latest)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await page.keyboard.press('Meta+,')
    expect(db.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toEqual(stored)
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id))!.saves?.mine).toBeUndefined()
    await page.getByTestId('backup-export').click()
    await expect(page.getByTestId('backup-said')).toHaveText("Couldn't save your latest changes. Return to your note and try again.")
    expect(await app.evaluate(() => (globalThis as unknown as { __backupCalls: number }).__backupCalls)).toBe(0)
    expect(readFileSync(out)).toEqual(original)
    await app.evaluate(() => (globalThis as unknown as { __recoverTransport(): void }).__recoverTransport())
    await page.getByTestId('backup-export').click()
    await expect(page.getByTestId('backup-said')).toContainText('Exported 1 meeting')
    expect(await app.evaluate(() => (globalThis as unknown as { __backupCalls: number }).__backupCalls)).toBe(1)
    const unpacked = mkdtempSync(join(tmpdir(), 'yogurt-transport-unpacked-'))
    execFileSync('/usr/bin/ditto', ['-x', '-k', out, unpacked])
    const snapshot = new DatabaseSync(join(unpacked, 'yogurt.db'), { readOnly: true })
    try { expect(snapshot.prepare('SELECT mine FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ mine: latest }) }
    finally { snapshot.close() }
  } finally {
    await app.evaluate(() => (globalThis as unknown as { __recoverTransport?: () => void }).__recoverTransport?.()).catch(() => {})
    db.close(); await app.close()
  }
})
