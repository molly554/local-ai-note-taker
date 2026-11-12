import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('delete distinguishes a recording from removal failure and keeps the note available to retry', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-delete-recovery-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings: (n: number) => unknown } }).__fake__.manyMeetings(1))
    await page.reload()
    // Delete forever lives in the Trash: every meeting goes there first
    await page.evaluate(async () => { for (const c of await window.yogurt.meetings.cards({ limit: 10 })) await window.yogurt.meetings.trash(c.id) })
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('trash-row')).toHaveCount(1)
    await page.getByTestId('trash-row').hover()
    await page.getByTestId('trash-delete').click()
    for (const result of ['recording', 'failed', 'rejected'] as const) {
      await app.evaluate(({ ipcMain }, result) => {
        ipcMain.removeHandler('meetings:delete')
        ipcMain.handle('meetings:delete', () => {
          if (result === 'rejected') throw new Error('removal failed')
          return result
        })
      }, result)
      await page.getByTestId('delete-yes').click()
      await expect(page.getByTestId('delete-confirm')).toContainText(result === 'recording'
        ? 'Stop the recording first, then try again.'
        : "Lynote NoteTaker couldn't finish deleting this note. Try again.")
      if (result !== 'recording') await expect(page.getByTestId('delete-confirm')).not.toContainText('Stop the recording')
      await expect(page.getByTestId('trash-row')).toHaveCount(1)
      await expect(page.getByTestId('delete-yes')).toBeEnabled()
    }
  } finally { await app.close() }
})
