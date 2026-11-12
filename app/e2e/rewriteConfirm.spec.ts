import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launchEdited() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-rewrite-confirm-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '2',
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
  await page.reload()
  await page.getByTestId('past-note').click()
  const editor = page.getByTestId('note-enhanced-editor'), trigger = page.getByTestId('note-view-menu')
  const exact = 'My edited notes must survive a cancelled rewrite.'
  await editor.fill(exact)
  await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
  return { app, page, editor, trigger, exact }
}

test('keyboard rewrite confirmation starts on Cancel, respects later Search, and restores its trigger on dismissal', async () => {
  const { app, page, editor, trigger, exact } = await launchEdited()
  try {
    await expect(page.getByRole('tablist')).toHaveCount(1)
    await expect(page.getByRole('tablist').getByRole('tab')).toHaveText(['Transcript', 'My notes', 'Summary'])
    await expect(page.getByRole('tablist').getByRole('button', { name: 'Summary actions' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Summary', exact: true })).toBeVisible()
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-write-again')).toBeFocused()
    await expect(page.getByTestId('note-write-again')).toHaveText('Regenerate summary')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('alertdialog', { name: 'Regenerate summary?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-describedby', 'note-rewrite-description')
    await expect(page.getByTestId('note-write-again-cancel')).toBeFocused()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('note-write-again-cancel')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(editor).toHaveText(exact)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-write-again-cancel')).toBeFocused()
    // Return on the initial focus cancels; replacing edits still needs an explicit confirmation.
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(editor).toHaveText(exact)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')
    await page.keyboard.press('Enter')
    await page.getByTestId('note-write-again').press('Enter')
    await expect(page.getByTestId('note-write-again-cancel')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('note-write-again-confirm')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(editor).toContainText('Launch plan')
  } finally { await app.close() }
})

test('explicit rewrite confirmation closes before a delayed save; a failed save still prevents generation', async () => {
  const { app, page, editor, trigger } = await launchEdited()
  try {
    await trigger.click()
    await page.getByTestId('note-write-again').click()
    await expect(page.getByTestId('note-confirm')).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers.get('notes:set-enhanced')!
      const state = globalThis as unknown as { __saveRequested: boolean; __failSave?: () => void; __restoreSave: () => void; __rewriteRequests: number }
      state.__saveRequested = false; state.__rewriteRequests = 0
      ipcMain.removeHandler('notes:set-enhanced')
      ipcMain.handle('notes:set-enhanced', (_e, _id, _md, revision) => new Promise((resolve) => {
        state.__saveRequested = true
        state.__failSave = () => resolve({ revision, status: 'failed', retained: false })
      }))
      state.__restoreSave = () => { ipcMain.removeHandler('notes:set-enhanced'); ipcMain.handle('notes:set-enhanced', original) }
      ipcMain.removeHandler('notes:write-again')
      ipcMain.handle('notes:write-again', () => { state.__rewriteRequests++ })
    })
    const latest = 'This edit still needs its save acknowledged.'
    await editor.fill(latest)
    await page.getByTestId('note-write-again-confirm').click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __saveRequested: boolean }).__saveRequested)).toBe(true)
    await expect(page.getByTestId('note-confirm')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await app.evaluate(() => (globalThis as unknown as { __failSave: () => void }).__failSave())
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'failed')
    await expect(editor).toHaveText(latest)
    expect(await app.evaluate(() => (globalThis as unknown as { __rewriteRequests: number }).__rewriteRequests)).toBe(0)
    await app.evaluate(() => (globalThis as unknown as { __restoreSave: () => void }).__restoreSave())
    await page.getByTestId('note-save-retry').click()
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
  } finally {
    await app.evaluate(() => {
      const state = globalThis as unknown as { __failSave?: () => void; __restoreSave?: () => void }
      state.__failSave?.(); state.__restoreSave?.()
    }).catch(() => {})
    await editor.focus().catch(() => {})
    await trigger.focus().catch(() => {})
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved').catch(() => {})
    await app.close()
  }
})

test('leaving Notes cancels an unconfirmed rewrite without focusing its now-hidden trigger', async () => {
  const { app, page, editor, trigger, exact } = await launchEdited()
  try {
    await trigger.click()
    await page.getByTestId('note-write-again').click()
    await expect(page.getByTestId('note-confirm')).toBeVisible()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-confirm')).toHaveCount(0)
    await expect(page.getByTestId('note-transcript-toggle')).toBeFocused()
    await page.getByTestId('note-summary-tab').click()
    await expect(editor).toHaveText(exact)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')
  } finally { await app.close() }
})
