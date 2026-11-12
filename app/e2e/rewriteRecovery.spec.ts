import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-rewrite-')), out = join(userData, 'export.md')
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_EXPORT_PATH: out, YOGURT_FAKE_LLM_MS: '2',
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(({ clipboard }) => {
    ;(globalThis as unknown as { __copied: string }).__copied = ''
    clipboard.write = async (items) => {
      const value = await items[0].getType('text/plain')
      ;(globalThis as unknown as { __copied: string }).__copied = await (value as Blob).text()
    }
    ;(globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true })
  })
  await page.reload()
  await page.getByTestId('past-note').click()
  await expect(page.getByTestId('note-enhanced')).toBeVisible()
  const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
  const db = new DatabaseSync(join(userData, 'yogurt.db'))
  return { app, page, id, db, out }
}
const fail = (db: DatabaseSync) => db.exec("CREATE TRIGGER test_rewrite_failure BEFORE INSERT ON notes BEGIN SELECT RAISE(FAIL, 'rewrite save failed'); END")
const recover = (db: DatabaseSync) => db.exec('DROP TRIGGER IF EXISTS test_rewrite_failure')

test('a failed rewrite keeps the previous edited Enhanced note visible, copyable and exportable; retry replaces it', async () => {
  const { app, page, id, db, out } = await launch()
  try {
    const prior = 'My exact decision before the failed rewrite.'
    await page.getByTestId('note-enhanced-editor').fill(prior)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    fail(db)
    await page.getByTestId('note-view-menu').click()
    await page.getByTestId('note-write-again').click()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced-rewrite-failed')).toBeVisible()
    await expect(page.getByTestId('note-enhanced-rewrite-failed')).toHaveAttribute('role', 'alert')
    const retry = page.getByTestId('note-enhanced-rewrite-failed').getByRole('button', { name: 'Try again' })
    await expect(retry).toHaveCSS('text-decoration-line', 'underline')
    expect(await retry.evaluate((el) => getComputedStyle(el).color)).not.toBe(await page.getByText("Couldn't regenerate the summary. Your previous version is below.").evaluate((el) => getComputedStyle(el).color))
    await expect(page.getByTestId('note-enhanced-editor')).toHaveText(prior)
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-summary').click()
    await expect(page.getByTestId('share-said')).toHaveText('Copied')
    expect(await app.evaluate(() => (globalThis as unknown as { __copied: string }).__copied)).toBe(prior)
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-export').click()
    await expect(page.getByTestId('share-said')).toHaveText('Saved')
    expect(readFileSync(out, 'utf8')).toContain(`## ${prior}`)
    expect(db.prepare('SELECT enhanced FROM notes WHERE meeting_id = ?').get(id)).toMatchObject({ enhanced: `## ${prior}` })
    recover(db)
    const delayed = await page.evaluate((id) => window.yogurt.notes.get(id), id)
    await page.getByTestId('note-enhanced-editor').fill('')
    await expect(page.getByTestId('note-enhanced-editor')).toBeVisible()
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-summary').click()
    await expect(page.getByTestId('share-said')).toHaveText('Nothing to copy yet')
    const edited = 'My newer correction after the failed rewrite.'
    await page.getByTestId('note-enhanced-editor').fill(edited)
    await app.evaluate(({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.webContents.send('notes:changed', value)
    }, delayed)
    await expect(page.getByTestId('note-enhanced-editor')).toHaveText(edited)
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id))!.enhanced).toContain(edited)
    await retry.click()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('Launch plan')
    await expect(page.getByTestId('note-enhanced-rewrite-failed')).toHaveCount(0)
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id))!.edited).toBe(false)
  } finally { recover(db); db.close(); await app.close() }
})

test('a first-generation failure retains its actionable retry and My notes copy fallback', async () => {
  const { app, page, id, db } = await launch()
  try {
    db.prepare('UPDATE notes SET enhanced = NULL, edited = 0, mine = ? WHERE meeting_id = ?').run('My original notes are still useful.', id)
    await page.reload()
    fail(db)
    await page.evaluate((id) => window.yogurt.notes.writeAgain(id), id)
    await expect(page.getByTestId('note-enhanced-failed')).toBeVisible()
    await expect(page.getByTestId('note-enhanced-failed')).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('note-enhanced-editor')).toHaveCount(0)
    await page.getByTestId('share-button').click()
    await expect(page.getByTestId('share-copy-summary')).toBeDisabled()
    await page.getByTestId('share-copy-notes').click()
    await expect(page.getByTestId('share-said')).toHaveText('Copied')
    recover(db)
    await page.getByTestId('note-enhanced-failed').getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')
  } finally { recover(db); db.close(); await app.close() }
})
