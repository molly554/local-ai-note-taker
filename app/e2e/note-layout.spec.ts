import { selectNoteVersion } from './noteVersion'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NoteView } from '../src/shared/types'

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
  return item?.types.includes('text/plain') ? (await item.getType('text/plain') as Blob).text() : ''
})
/** the person's own clipboard, put back after a test that overwrites it (as in share.spec.ts) */
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
const notesOf = (page: Page, id: string) => page.evaluate((id) => window.yogurt.notes.get(id), id) as Promise<NoteView>

/** a meeting recorded, heard and written up: the note is open with enhanced notes done; its id */
async function finished(app: ElectronApplication, page: Page): Promise<string> {
  await fake(app, 'signals', { micApps: [], events: [] })
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('note-stop').click()
  await page.getByTestId('note-summary-tab').click()
  await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  return (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
}

test('the workspace keeps Meetings and Back navigation, including a return from Settings', async () => {
  const { app, page } = await launch()
  try {
    await finished(app, page)
    const search = page.getByTestId('search-open')
    await expect(search).toBeVisible()
    expect(await search.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    await search.click()
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('past-note').first().click()
    await expect(page.getByTestId('note-title')).toBeVisible()
    await expect(page.getByTestId('nav-back')).toBeVisible()
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('note-title')).toBeVisible()
    await expect(page.getByTestId('nav-back')).toBeVisible()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe('')
  } finally { await app.close() }
})

test('Copy beside the meeting controls offers explicit versions and export', async () => {
  const { app, page } = await launch()
  await keepClipboard(app)
  try {
    await finished(app, page)
    await expect(page.locator('.note-header').getByTestId('share-button')).toHaveText('Copy')
    await page.getByTestId('share-button').click()
    await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText([/Copy my notes/, /Copy summary/, /Copy transcript/, /Export as Markdown/])
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('share-menu')).toHaveCount(0)
    await page.getByTestId('share-button').click()
    await page.getByTestId('share-copy-summary').click()
    await expect(page.getByTestId('share-said')).toHaveText('Copied')
    expect(await clip(app)).toContain('Launch plan')
    // the old buttons inside the note are gone: only the top bar has them
    await expect(page.getByTestId('share-button')).toHaveCount(1)
    await expect(page.getByTestId('note-menu-button')).toHaveCount(1)
  } finally { await putClipboardBack(app); await app.close() }
})

test('My notes and Summary tabs switch versions; summary actions regenerate', async () => {
  const { app, page } = await launch()
  try {
    const id = await finished(app, page)
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'enhanced')
    await selectNoteVersion(page, 'mine')
    await expect(page.getByTestId('note-mine')).toBeVisible()
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'mine')
    await page.getByTestId('note-view-menu').click()
    await page.getByTestId('note-write-again').click()
    // written again from My notes: the enhanced notes are shown as they come
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'enhanced')
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'writing', { timeout: 30_000 })
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    expect((await notesOf(page, id)).edited).toBe(false)
  } finally { await app.close() }
})

test('people added and removed by hand are saved, and the notes are written again with them', async () => {
  // no names from the fake call, so the meeting starts with nobody but the person
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    const id = await finished(app, page)
    const editor = page.getByTestId('note-enhanced-editor')
    await expect(page.getByTestId('note-date')).toContainText('Today')
    await expect(page.getByTestId('note-attendees-summary')).toHaveText('Add attendees')
    await page.getByTestId('note-attendees').click()
    const card = page.getByTestId('people-card')
    await expect(card.getByTestId('note-date-card')).toHaveCount(0)
    await expect(card.getByText('Who was there', { exact: true })).toHaveCount(0)
    await expect(card.getByTestId('people-add')).toBeFocused()
    await expect(card.getByTestId('people-private')).toHaveText('Nothing is sent. This is only for your notes.')
    await expect(card.getByTestId('people-add')).toHaveAttribute('placeholder', 'Name or email')
    expect(await card.getByTestId('people-list').evaluate((list) => !!(list.compareDocumentPosition(document.querySelector('[data-testid="people-add"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    await expect(card.locator('.person-initials')).toHaveCount(0)
    await expect(card.getByTestId('people-row')).toHaveCount(1)
    await expect(card.getByTestId('people-row').first()).toContainText('(me)')
    await card.getByTestId('people-add').fill('Maya Chen maya@example.com')
    await page.keyboard.press('Enter')
    await expect(card.getByTestId('people-row')).toHaveCount(2)
    await expect(card.getByTestId('people-count')).toHaveCount(0)
    await expect(card.getByTestId('people-row').nth(1).getByTestId('people-name')).toHaveText('Maya Chen')
    await expect(card.getByTestId('people-email')).toHaveText('maya@example.com')
    await page.mouse.move(0, 0)
    await expect(card.getByTestId('people-remove')).toHaveCSS('opacity', '0')
    await card.getByTestId('people-remove').focus()
    await expect(card.getByTestId('people-remove')).toHaveCSS('opacity', '1')
    await expect(page.getByTestId('note-attendees-summary')).toHaveText('Maya')
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.attendees).toEqual([{ name: 'Maya Chen', email: 'maya@example.com' }])
    await expect(editor).toContainText('With Maya Chen.', { timeout: 30_000 })
    await card.getByTestId('people-row').nth(1).hover()
    await card.getByTestId('people-remove').click()
    await expect(card.getByTestId('people-row')).toHaveCount(1)
    await expect(editor).not.toContainText('With Maya Chen.', { timeout: 30_000 })
    await expect(page.getByTestId('note-people-changed')).toHaveCount(0)
  } finally { await app.close() }
})

test('people changed on edited notes: they are kept, and Lynote NoteTaker offers to write them again', async () => {
  const { app, page } = await launch()
  try {
    const id = await finished(app, page)
    const editor = page.getByTestId('note-enhanced-editor')
    await editor.locator('h2').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (mine)')
    await expect.poll(async () => (await notesOf(page, id)).edited, { timeout: 5000 }).toBe(true)
    await page.getByTestId('note-attendees').click()
    await page.getByTestId('people-add-open').click()
    await page.getByTestId('people-add').fill('Maya Chen')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-people-changed')).toHaveText(/People changed\. Regenerate summary\?/, { timeout: 10_000 })
    await expect(editor.locator('h2').first()).toHaveText('Launch plan (mine)')
  } finally { await app.close() }
})

test('linking an event updates the date chip, people chip and Summary separately', async () => {
  const { app, page } = await launch()
  try {
    const id = await finished(app, page)
    await page.getByTestId('note-date').click()
    await page.getByTestId('note-date-events-toggle').click()
    await page.getByTestId('note-date-event').filter({ hasText: 'Team standup' }).click()
    await expect(page.getByTestId('note-title')).toHaveText('Team standup')
    await expect(page.getByTestId('note-attendees-summary')).toHaveText('Ann, Bo')
    await page.getByTestId('note-attendees').click()
    await expect(page.getByTestId('people-row')).toHaveCount(3)
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.eventId).toMatch(/^fake-standup:/)
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('With Ann Lee, Bo Park.', { timeout: 30_000 })
  } finally { await app.close() }
})

test('a follow-up email can still be requested through the ordinary Ask composer', async () => {
  const { app, page } = await launch()
  try {
    await finished(app, page)
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-input')).toHaveAttribute('placeholder', 'Ask anything')
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    await page.getByTestId('chat-input').fill('Write a follow-up email')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-question')).toContainText('follow-up email')
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('note-bar')).toBeVisible()
  } finally { await app.close() }
})
