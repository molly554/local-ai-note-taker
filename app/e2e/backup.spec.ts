import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string>) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

test('every meeting goes to one file and into a fresh Yogurt, with notes, transcript, audio and search; twice adds nothing', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-backup-')), 'Yogurt backup.zip')
  const a = await launch({ YOGURT_BACKUP_PATH: file })
  let id: string
  try {
    await fake(a.app, 'manyMeetings', { n: 3, clean: true })
    id = await fake<string>(a.app, 'bigMeeting', 4)
    await a.page.getByTestId('settings-open').click()
    await a.page.getByTestId('backup-export').click()
    await expect(a.page.getByTestId('backup-said')).toContainText('Exported 4 meetings')
    await expect(a.page.getByTestId('backup-show')).toBeVisible()
  } finally { await a.app.close() }
  expect(existsSync(file)).toBe(true)

  const b = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await expect(b.page.getByTestId('past-note')).toHaveCount(0)
    await b.page.getByTestId('settings-open').click()
    await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Added 4 meetings.')
    await b.page.getByTestId('nav-home').click()
    // home heard about it without a reload
    await expect(b.page.getByTestId('past-note')).toHaveCount(4)
    expect(existsSync(join(b.userData, 'meetings', id, 'me.wav'))).toBe(true)

    await b.page.keyboard.press('Meta+k')
    await b.page.keyboard.type('long meeting')
    await expect(b.page.getByTestId('search-result').first()).toContainText('Long meeting')
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('search')).toHaveCount(0)
    await b.page.keyboard.press('Meta+k')
    await expect(b.page.getByTestId('search-input')).toBeFocused()
    await b.page.keyboard.press('Meta+a')
    await b.page.keyboard.type('invite flow')
    await expect(b.page.getByTestId('search-result').first()).toContainText('Customer call with Acme')
    await b.page.keyboard.press('Enter')
    await expect(b.page.getByTestId('note-enhanced')).toContainText('a simpler invite flow')

    await fake(b.app, 'go', `/note/${id}`)
    await b.page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(b.page.getByTestId('transcript-line')).toHaveCount(4)
    await expect(b.page.getByTestId('transcript-line').first()).toContainText('Line 1 of the long meeting.')

    await fake(b.app, 'go', '/settings')
    await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Nothing new in this backup. 4 were already here.')
    await b.page.getByTestId('nav-home').click()
    await expect(b.page.getByTestId('past-note')).toHaveCount(4)
  } finally { await b.app.close() }
})

// the zip itself differs by computer (ditto on a Mac, JavaScript elsewhere): the round trip must hold on each
test('@everywhere a backup restores into a fresh Yogurt on this computer, recordings too', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt backup ü-')), 'Yogurt backup.zip')
  const a = await launch({ YOGURT_BACKUP_PATH: file })
  let id: string
  try {
    id = await fake<string>(a.app, 'bigMeeting', 4)
    await a.page.getByTestId('settings-open').click()
    await a.page.getByTestId('backup-export').click()
    await expect(a.page.getByTestId('backup-said')).toContainText('Exported 1 meeting')
  } finally { await a.app.close() }
  const b = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await b.page.getByTestId('settings-open').click()
    await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Added 1 meeting.')
    expect(existsSync(join(b.userData, 'meetings', id, 'me.wav'))).toBe(true)
  } finally { await b.app.close() }
})

test('import waits while a meeting records, and an unreadable file reports a retryable failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-backup-'))
  const { app, page } = await launch({ YOGURT_BACKUP_PATH: join(dir, 'missing.zip') })
  try {
    await page.getByTestId('settings-open').click()
    await page.getByTestId('backup-import').click()
    await expect(page.getByTestId('backup-said')).toHaveText("Couldn't import that backup. Try again.")
    // a new note from the menu bar starts recording
    await fake(app, 'trayClick', 'new')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await fake(app, 'go', '/settings')
    await expect(page.getByTestId('backup-import')).toBeDisabled()
    await expect(page.getByTestId('backup-wait')).toBeVisible()
    await expect(page.getByTestId('backup-export')).toBeEnabled()
  } finally { await app.close() }
})

test('Settings shows rejected backup requests and allows retrying', async () => {
  const { app, page } = await launch({})
  try {
    await page.getByTestId('settings-open').click()
    await app.evaluate(({ ipcMain }) => {
      for (const name of ['backup:export', 'backup:import']) {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, () => { throw new Error('backup request rejected') })
      }
    })
    await page.getByTestId('backup-export').click()
    await expect(page.getByTestId('backup-said')).toHaveText("Couldn't save the backup. Try again, or pick another place.")
    await expect(page.getByTestId('backup-said')).toHaveAttribute('data-kind', 'error')
    await expect(page.getByTestId('backup-export')).toBeEnabled()
    await page.getByTestId('backup-import').click()
    await expect(page.getByTestId('backup-said')).toHaveText("Couldn't import that backup. Try again.")
    await expect(page.getByTestId('backup-import')).toBeEnabled()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('backup:import')
      ipcMain.handle('backup:import', () => ({ ok: true, added: 1, skipped: 0 }))
    })
    await page.getByTestId('backup-import').click()
    await expect(page.getByTestId('backup-said')).toHaveText('Added 1 meeting.')
    await expect(page.getByTestId('backup-said')).toHaveAttribute('data-kind', 'imported')
  } finally { await app.close() }
})
