import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
const clip = (app: ElectronApplication) => app.evaluate(async ({ clipboard }) => {
  const item = (await clipboard.read())[0]
  const get = async (type: string) => (item?.types.includes(type) ? (await item.getType(type) as Blob).text() : '')
  return { text: await get('text/plain'), html: await get('text/html') }
})

/** the person's own clipboard, put back after a test that overwrites it */
const keepClipboard = (app: ElectronApplication) => app.evaluate(async ({ clipboard }) => {
  const item = (await clipboard.read())[0]
  const get = async (type: string) => (item?.types.includes(type) ? (await item.getType(type) as Blob).text() : undefined)
  ;(globalThis as unknown as { __kept: Record<string, string | undefined> }).__kept = { 'text/plain': await get('text/plain'), 'text/html': await get('text/html') }
})
const putClipboardBack = (app: ElectronApplication) => app.evaluate(async ({ clipboard, ClipboardItem }) => {
  const kept = (globalThis as unknown as { __kept?: Record<string, string | undefined> }).__kept ?? {}
  const parts = Object.fromEntries(Object.entries(kept).filter(([, v]) => v)) as Record<string, string>
  if (Object.keys(parts).length) await clipboard.write([new ClipboardItem(parts)]); else clipboard.clear()
})

/** a meeting recorded, heard and written up: the note is open with enhanced notes done */
async function finished(app: ElectronApplication, page: Page) {
  await fake(app, 'signals', { micApps: [], events: [] })
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('note-stop').click()
  await page.getByRole('tab', { name: 'Summary', exact: true }).click()
  await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  await expect(page.getByTestId('note-enhanced')).toBeVisible()
}

test('the menu copies the notes as text and HTML, the transcript, and Mac shortcut copies too', async () => {
  const { app, page } = await launch()
  await keepClipboard(app)
  try {
    await finished(app, page)
    await page.getByTestId('share-button').click()
    await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText([/Copy my notes/, /Copy summary/, /Copy transcript/, /Export as Markdown/])
    await page.getByTestId('share-copy-summary').click()
    await expect(page.getByTestId('share-said')).toHaveText('Copied')
    await expect(page.getByTestId('share-button')).toHaveAttribute('data-state', 'copied')
    const copyBox = (await page.getByTestId('share-button').boundingBox())!
    const feedbackBox = (await page.getByTestId('share-said').boundingBox())!
    expect(feedbackBox.y).toBeGreaterThanOrEqual(copyBox.y + copyBox.height)
    const c = await clip(app)
    expect(c.text).toContain('Launch plan\n• ')
    expect(c.text).toContain('• The site goes live on Tuesday')
    expect(c.text).toContain('  • The email goes out on Wednesday morning.')
    expect(c.html).toContain('<h2>Launch plan</h2>')
    expect(c.html).toMatch(/<ul>.*<ul>.*<\/ul>.*<\/ul>/)
    expect(c.html).toContain('<strong>Tuesday</strong>')

    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-transcript').click()
    const t = await clip(app)
    expect(t.text).toMatch(/^(You|Them|Speaker \w|Ann Lee|Bo Park) \(\d+:\d\d\)\n/)
    expect(t.text).toContain('The site goes live on Tuesday')

    // the keyboard: the menu opens on Enter, arrows move, Escape closes and gives focus back
    await page.getByTestId('share-button').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('share-copy-notes')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('share-copy-summary')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('share-menu')).toHaveCount(0)
    await expect(page.getByTestId('share-button')).toBeFocused()

    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.keyboard.press('Meta+Shift+C')
    await expect(page.getByTestId('share-said')).toHaveText('Copied')
    expect((await clip(app)).text).toContain('Launch plan')
  } finally { await putClipboardBack(app); await app.close() }
})

test('Export as Markdown writes the title, notes and transcript to the file the save step gives', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-export-')), 'out.md')
  const { app, page } = await launch({ YOGURT_EXPORT_PATH: file })
  try {
    await finished(app, page)
    // The auto-title is a separate job after notes finish; compare one settled snapshot.
    await expect(page.getByTestId('note-title')).not.toHaveText('Zoom call')
    const title = (await page.getByTestId('note-title').textContent())!
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-export').click()
    await expect(page.getByTestId('share-said')).toHaveText('Saved')
    expect(existsSync(file)).toBe(true)
    const md = readFileSync(file, 'utf8')
    const at = [`# ${title}`, '## Launch plan', '- The site goes live on **Tuesday**.', '## Transcript', 'The site goes live on Tuesday'].map((s) => md.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(md).not.toContain('<mine>')
    // a blank line between a name and its words
    expect(md).toMatch(/\*\*[^*]+\*\* \(\d+:\d\d\)\n\n\S/)
  } finally { await app.close() }
})

test('while the notes are still being written, copy and export do nothing and say so', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-export-')), 'out.md')
  const { app, page } = await launch({ YOGURT_EXPORT_PATH: file, YOGURT_FAKE_LLM_MS: '500' })
  try {
    // This app must never touch the clipboard; other apps may use the system clipboard during the test.
    await app.evaluate(({ clipboard }) => {
      const state = globalThis as unknown as { copyCalls: number }; state.copyCalls = 0
      clipboard.write = async () => { state.copyCalls++ }
    })
    await fake(app, 'signals', { micApps: [], events: [] })
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('note-stop').click()
    await page.getByRole('tab', { name: 'Summary', exact: true }).click()
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', /waiting|writing/, { timeout: 30_000 })
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-summary').click()
    await expect(page.getByTestId('share-said')).toHaveText('Still generating your summary')
    expect(await page.getByTestId('share-said').locator('svg').count()).toBe(0)
    await expect(page.getByTestId('share-button')).toHaveAttribute('data-state', 'idle')
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-export').click()
    await expect(page.getByTestId('share-said')).toHaveText('Still generating your summary')
    expect(await app.evaluate(() => (globalThis as unknown as { copyCalls: number }).copyCalls)).toBe(0)
    expect(existsSync(file)).toBe(false)
  } finally { await app.close() }
})

test('empty and failed copy feedback never signals success', async () => {
  const { app, page } = await launch()
  try {
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await page.getByRole('tab', { name: 'My notes', exact: true }).click()
    await expect(page.getByTestId('note-mine')).toBeVisible()
    const copy = page.getByTestId('share-button')
    await copy.click()
    await page.getByTestId('share-copy-notes').click()
    await expect(page.getByTestId('share-said')).toHaveText('Nothing to copy yet')
    expect(await page.getByTestId('share-said').locator('svg').count()).toBe(0)
    await expect(copy).toHaveAttribute('data-state', 'idle')
    // A clipboard failure at the existing IPC boundary must stay a failure in the UI.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('share:copy')
      ipcMain.handle('share:copy', () => 'failed')
    })
    await copy.click()
    await page.getByTestId('share-copy-notes').click()
    await expect(page.getByTestId('share-said')).toHaveText("Couldn't copy. Try again.")
    await expect(page.getByTestId('share-said')).toHaveAttribute('data-tone', 'error')
    await expect(page.getByTestId('share-said').getByTestId('share-success')).toHaveCount(0)
    await expect(copy).toHaveAttribute('data-state', 'idle')
  } finally { await app.close() }
})
