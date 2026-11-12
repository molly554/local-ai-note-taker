import { selectNoteVersion } from './noteVersion'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NoteView } from '../src/shared/types'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
type Snap = { visible: boolean; view: { kind: string; meetingId: string } | null; notice: { title: string; body: string; meetingId: string } | null }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
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
/** a call starts and Take notes is pressed: the meeting is recording; its id */
async function record(app: ElectronApplication, page: Page, primary: 'notes' | 'transcript' = 'notes'): Promise<string> {
  await fake(app, 'signals', { micApps: [], events: [] })
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  if (primary === 'transcript') await page.getByTestId('note-transcript-toggle').click()
  return (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
}
const notesOf = (page: Page, id: string) => page.evaluate((id) => window.yogurt.notes.get(id), id) as Promise<NoteView>
/** the fake call's lines have been heard (both sides), so there is something to write up */
const heard = (page: Page, id: string) => expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)

test('Stop ends recording when its metadata cannot save, and Retry saves without stopping twice', async () => {
  const { app, page, userData } = await launch()
  const db = new DatabaseSync(join(userData, 'yogurt.db'))
  try {
    const id = await record(app, page)
    await page.getByTestId('note-mine').fill('Remember to send the launch plan.')
    await expect.poll(async () => (await notesOf(page, id)).mine).toContain('launch plan')
    // A real SQLite write failure, confined to this disposable fake profile and the stop metadata.
    db.exec("CREATE TRIGGER test_stop_write_failure BEFORE UPDATE OF ended_at ON meetings BEGIN SELECT RAISE(FAIL, 'test stop write failure'); END")
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-stop-unsaved')).toBeVisible()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'stopped')
    await expect(page.getByTestId('note-stop')).toHaveCount(0)
    const pending = await page.evaluate((id) => window.yogurt.meetings.get(id), id)
    expect(pending).toMatchObject({ state: 'stopped', stopSavePending: true })
    expect(db.prepare('SELECT state, ended_at FROM meetings WHERE id = ?').get(id)).toMatchObject({ state: 'recording', ended_at: null })
    expect((await notesOf(page, id)).status).toBe('idle')
    expect(await fake<Snap>(app, 'widget')).toMatchObject({ visible: false, notice: { title: 'Recording stopped. Open Lynote NoteTaker to finish saving.', meetingId: id } })
    await page.getByTestId('note-menu-button').click()
    await expect(page.getByTestId('note-delete')).toBeDisabled()
    await expect(page.getByTestId('note-delete')).toContainText('Finish saving first')
    await page.keyboard.press('Escape')
    expect(await page.evaluate((id) => window.yogurt.meetings.delete(id), id)).toBe('save-pending')
    expect(await page.evaluate((id) => window.yogurt.meetings.trash(id), id)).toBe('save-pending')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').hover()
    await page.getByTestId('past-note-more').click()
    await page.getByTestId('past-note-trash').click()
    await expect(page.getByTestId('trash-toast')).toContainText('Open this note and finish saving before deleting it.')
    await expect(page.getByTestId('trash-undo')).toHaveCount(0)
    await expect(page.getByTestId('past-note')).toHaveCount(1)
    await page.getByTestId('past-note').click()
    await expect.poll(() => page.getByTestId('trash-toast').evaluate((toast) => {
      const footer = document.querySelector('.note-footer')!.getBoundingClientRect()
      return footer.top - toast.getBoundingClientRect().bottom
    })).toBeGreaterThanOrEqual(12)
    await page.getByTestId('note-stop-retry').click()
    await expect(page.getByTestId('note-stop-unsaved')).toBeVisible()
    await page.waitForTimeout(4200)
    expect(await fake<Snap>(app, 'widget')).toMatchObject({ visible: false, notice: { title: 'Recording stopped. Open Lynote NoteTaker to finish saving.', meetingId: id } })
    db.exec('DROP TRIGGER test_stop_write_failure')
    await page.getByTestId('note-stop-retry').click()
    await expect(page.getByTestId('note-stop-unsaved')).toHaveCount(0)
    await expect(page.getByTestId('note-transcript-toggle')).toBeFocused()
    expect(db.prepare('SELECT ended_at FROM meetings WHERE id = ?').get(id)).toMatchObject({ ended_at: pending!.endedAt })
    // Saving the pending timestamp clears its current warning without sending a second completion notice.
    expect(await fake<Snap>(app, 'widget')).toMatchObject({ visible: false, view: { note: null }, notice: { title: 'Recording stopped. Open Lynote NoteTaker to finish saving.', meetingId: id } })
    await expect.poll(async () => (await notesOf(page, id)).status).toBe('done')
  } finally { db.close(); await app.close() }
})
const stop = async (page: Page) => { await page.getByTestId('note-stop').click(); await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true') }

test('streaming a summary keeps existing blocks at full opacity as nested lists grow', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '100' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 20)
    await fake(app, 'go', `/note/${id}`)
    await page.evaluate(id => window.yogurt.notes.writeAgain(id), id)
    await page.getByTestId('note-summary-tab').click()
    await expect(page.getByTestId('note-enhanced-editor').locator('h2')).toBeVisible()
    const dimmed = page.getByTestId('note-enhanced-editor').evaluate(editor => new Promise<string[]>((resolve) => {
      const failures = new Set<string>()
      const sample = () => {
        for (const block of Array.from(editor.querySelectorAll('h2, p, ul, ol, li'))) {
          if (block.textContent && Number(getComputedStyle(block).opacity) < 1) failures.add(block.tagName)
        }
        if (editor.closest('[data-status="writing"]')) requestAnimationFrame(sample)
        else resolve([...failures])
      }
      sample()
    }))
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
    expect(await dimmed).toEqual([])
    await expect(page.getByTestId('note-enhanced-editor').locator('ul ul li')).toContainText('Wednesday morning')
  } finally { await app.close() }
})

test('starting a recording opens My notes, with the live transcript one tab away', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    expect(await fake<{ presented: number; route: string }>(app, 'main')).toMatchObject({ presented: 1, route: `/note/${id}` })
    await expect(page.getByTestId('note-title')).toBeVisible()
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: 'My notes', exact: true })).toBeVisible()
    await expect(page.getByTestId('transcript-panel')).toBeHidden()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'My notes', exact: true })).toBeHidden()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByRole('textbox', { name: 'My notes', exact: true })).toBeVisible()
    await expect(page.getByTestId('transcript-panel')).toBeHidden()
  } finally { await app.close() }
})

test('typing during the meeting is saved a second later, and is still there after a reload', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    const mine = page.getByRole('textbox', { name: 'My notes', exact: true })
    await expect(mine).toHaveAttribute('aria-multiline', 'true')
    await expect(mine).toHaveAttribute('contenteditable', 'true')
    // no switch while recording: there is only their notes
    await expect(page.getByTestId('note-summary-tab')).toHaveCount(0)
    await mine.click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('Launch moves to Tuesday')
    await expect.poll(async () => (await notesOf(page, id)).mine, { timeout: 5000 }).toBe('Launch moves to Tuesday')
    await page.keyboard.press('Enter')
    await page.keyboard.type('- pricing page **review**')
    await expect.poll(async () => (await notesOf(page, id)).mine, { timeout: 5000 }).toBe('Launch moves to Tuesday\n- pricing page **review**')
    await page.reload()
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('note-mine')).toContainText('Launch moves to Tuesday')
    await expect(page.getByTestId('note-mine').locator('li strong')).toHaveText('review')
  } finally { await app.close() }
})

test('stopping writes the enhanced notes, streamed in, with their own line marked; the switch flips between the two', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('ship site on tuesday')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    // Choosing Notes is respected when the recording finishes.
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('transcript-panel')).toBeHidden()
    await stop(page)
    // Enhanced is shown by itself once it exists
    await expect(page.getByTestId('note-summary-tab')).toBeVisible()
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'enhanced', { timeout: 10_000 })
    const enhanced = page.getByTestId('note-enhanced')
    await expect(enhanced).toHaveAttribute('data-status', 'writing', { timeout: 30_000 })
    await expect(enhanced).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    const editor = page.getByTestId('note-enhanced-editor')
    await expect(editor.locator('h2').first()).toHaveText('Launch plan')
    await expect(editor.locator('.mine')).toHaveText('ship site on tuesday')
    await expect(editor.locator('li strong').filter({ hasText: 'You:' })).toBeVisible()
    expect((await notesOf(page, id)).enhanced).toContain('<mine>ship site on tuesday</mine>')
    await expect(page.getByTestId('note-duration')).toHaveText('1 min')

    await selectNoteVersion(page, 'mine')
    await expect(page.getByTestId('note-mine')).toHaveText('ship site on tuesday')
    await expect(page.getByTestId('note-enhanced')).toHaveCount(0)
    await selectNoteVersion(page, 'enhanced')
    await expect(page.getByTestId('note-enhanced-editor').locator('h2').first()).toHaveText('Launch plan')
    await page.getByTestId('note-summary-tab').press('ArrowLeft')
    await expect(page.getByTestId('note-notes-tab')).toBeFocused()
    await page.getByTestId('note-notes-tab').press('End')
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'enhanced')
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-input')).toBeFocused()
    await page.keyboard.press('Meta+k')
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('search-input')).toBeFocused()
  } finally { await app.close() }
})

test('the notes are written with the names from the call', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    // the fixture's second line of the other side, at 13.3 s, is Bo Park's
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).some((l) => l.text.startsWith('She will send')), { timeout: 40_000 }).toBe(true)
    await stop(page)
    const enhanced = page.getByTestId('note-enhanced')
    await expect(enhanced).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    const editor = page.getByTestId('note-enhanced-editor')
    // the fake model names the owner it finds in the transcript ("Bo Park: She will send a draft")
    await expect(editor).toContainText('Bo Park: Send the release notes draft by Friday.')
    await expect(editor).not.toContainText('Speaker')
    expect((await notesOf(page, id)).enhanced).toContain('**Bo Park:**')
  } finally { await app.close() }
})

test('edits to the enhanced notes are saved; Write again asks first, then writes them again', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await heard(page, id)
    await stop(page)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    const editor = page.getByRole('textbox', { name: 'Summary', exact: true })
    await expect(editor).toHaveAttribute('aria-multiline', 'true')
    await expect(editor).toHaveAttribute('aria-readonly', 'false')
    await editor.locator('h2').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (moved)')
    await expect.poll(async () => (await notesOf(page, id)).enhanced, { timeout: 5000 }).toContain('## Launch plan (moved)')
    await page.getByTestId('note-view-menu').click()
    await page.getByTestId('note-write-again').click()
    await expect(page.getByTestId('note-confirm')).toBeVisible()
    await page.getByTestId('note-write-again-confirm').click()
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'writing', { timeout: 30_000 })
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    await expect(editor.locator('h2').first()).toHaveText('Launch plan')
    expect((await notesOf(page, id)).edited).toBe(false)
  } finally { await app.close() }
})

test('switching to another note within a second of typing saves the text to the note it was typed in', async () => {
  const { app, page } = await launch()
  try {
    const a = await record(app, page)
    await stop(page)
    const b = await record(app, page)
    await fake(app, 'go', `/note/${a}`)
    await expect(page.getByTestId('note-title')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe(`/note/${a}`)
    await selectNoteVersion(page, 'mine').catch(() => {})
    await page.getByTestId('note-mine').click({ position: { x: 24, y: 12 } })
    await page.keyboard.type('only for the first meeting')
    // straight away, before the 1 s save
    await fake(app, 'go', `/note/${b}`)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect.poll(async () => (await notesOf(page, a)).mine, { timeout: 5000 }).toBe('only for the first meeting')
    await new Promise((r) => setTimeout(r, 1500))
    expect((await notesOf(page, b)).mine).toBe('')
    await expect(page.getByTestId('note-mine')).not.toContainText('only for the first meeting')
  } finally { await app.close() }
})

test('edits to the enhanced notes stay through flipping to My notes and back, and after a reload', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await heard(page, id)
    await stop(page)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    const editor = page.getByTestId('note-enhanced-editor')
    await editor.locator('h2').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' first')
    // flipped away at once, before the save
    await selectNoteVersion(page, 'mine')
    await selectNoteVersion(page, 'enhanced')
    await expect(editor.locator('h2').first()).toHaveText('Launch plan first')
    await editor.locator('h2').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' second')
    await expect.poll(async () => (await notesOf(page, id)).enhanced, { timeout: 5000 }).toContain('## Launch plan first second')
    await page.reload()
    await expect(page.getByTestId('note-enhanced-editor').locator('h2').first()).toHaveText('Launch plan first second')
  } finally { await app.close() }
})

for (const small of [false, true]) {
  test(`a second meeting started while the first one's notes are written keeps recording; the first one's notes finish${small ? ' after it (16 GB Mac)' : ''}`, async () => {
    // slow notes, so the second meeting starts while they are being written
    const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '250', ...(small ? { YOGURT_FAKE_SMALL_MAC: '1' } : {}) })
    try {
      const a = await record(app, page)
      await heard(page, a)
      await stop(page)
      await expect.poll(async () => (await notesOf(page, a)).status, { timeout: 30_000 }).toBe('writing')
      const b = await record(app, page)
      expect(b).not.toBe(a)
      expect((await notesOf(page, a)).status).not.toBe('done')
      const w = await windowOf(app, '#widget')
      await expect(w.getByTestId('widget')).toHaveAttribute('data-kind', 'recording')
      expect((await fake<Snap>(app, 'widget')).view).toMatchObject({ kind: 'recording', meetingId: b })
      // on a 16 GB Mac the first meeting's notes stop and wait for this one; on a bigger Mac they carry on
      if (small) await expect.poll(async () => (await notesOf(page, a)).status, { timeout: 10_000 }).toBe('waiting')
      else await expect.poll(async () => (await notesOf(page, a)).status, { timeout: 30_000 }).toBe('done')
      // the second meeting is still recording and hearing both sides
      await page.getByTestId('note-transcript-toggle').click()
      await expect(page.getByTestId('transcript-line').filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
      expect((await fake<Snap>(app, 'widget')).view).toMatchObject({ kind: 'recording', meetingId: b })
      await stop(page)
      await expect.poll(async () => (await notesOf(page, a)).status, { timeout: 60_000 }).toBe('done')
      await expect.poll(async () => (await notesOf(page, b)).status, { timeout: 60_000 }).toBe('done')
    } finally { await app.close() }
  })
}

test('the recording header keeps status, time and actions while Transcript and Ask stay independently usable', async () => {
  const { app, page } = await launch()
  try {
    await record(app, page, 'transcript')
    const bar = page.getByTestId('rec-bar'), panel = page.getByTestId('transcript-panel')
    await expect(bar.getByTestId('note-stop')).toBeVisible()
    await expect(bar.getByTestId('note-pause')).toBeVisible()
    await expect(page.getByTestId('rec-mic')).toHaveText('MacBook Pro Microphone')
    await expect.poll(() => page.getByTestId('note-elapsed').innerText()).not.toBe('0:00')
    await expect(page.getByTestId('transcript-consent')).toHaveCount(0)
    const lines = page.getByTestId('transcript-line')
    const theirs = lines.filter({ hasText: 'The site goes live on Tuesday' })
    await expect(theirs).toHaveText(/^Sure\./, { timeout: 30_000 })
    await expect(page.getByTestId('transcript-turn').filter({ has: theirs }).getByTestId('transcript-who')).toHaveText('Ann Lee')
    await expect(page.getByTestId('transcript')).not.toContainText(/Speaker/)
    await page.getByTestId('transcript-search').fill('tuesday')
    await expect(lines).toHaveCount(1)
    await expect(lines.first()).toContainText('The site goes live on Tuesday')
    await page.getByTestId('transcript-search').fill('')
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' })).toHaveCount(1)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('note-transcript-toggle')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(page.getByTestId('share-button')).toBeVisible()
    await expect(page.getByTestId('transcript-close')).toHaveCount(0)
    await page.getByTestId('transcript-search').focus()
    await page.keyboard.press('Escape')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('transcript-search')).toBeFocused()
    await page.getByTestId('note-notes-tab').click()
    await expect(panel).toBeHidden()
    await expect(bar).toBeVisible()
  } finally { await app.close() }
})

test('Finish in the note header stops the meeting and hides the widget', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-stop')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.state).not.toBe('recording')
    expect((await fake<Snap>(app, 'widget')).view).toMatchObject({ kind: 'captured', meetingId: id })
  } finally { await app.close() }
})

test('a call with no event gets a title from its notes; one they typed is kept', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await expect(page.getByTestId('note-title')).toHaveText('Zoom call')
    await heard(page, id)
    await stop(page)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    await expect(page.getByTestId('note-title')).toHaveText('Launch plan and release notes', { timeout: 10_000 })
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))!.title).toBe('Launch plan and release notes')
    // the notes never carry the title
    expect((await notesOf(page, id)).enhanced).not.toContain('Launch plan and release notes')

    const second = await record(app, page)
    await page.getByTestId('note-title').getByRole('button').click()
    await page.getByTestId('note-title-input').fill('Budget review')
    await page.getByTestId('note-title-input').press('Enter')
    await heard(page, second)
    await stop(page)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
    await expect(page.getByTestId('note-title')).toHaveText('Budget review')
  } finally { await app.close() }
})

test('clicking the title renames the note; Escape keeps the old one; home and the widget show the new one', async () => {
  const { app, page } = await launch()
  try {
    const id = await record(app, page)
    await page.getByTestId('note-title').getByRole('button').click()
    const input = page.getByTestId('note-title-input')
    await input.fill('Budget review')
    await input.press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText('Budget review')
    expect((await fake<{ view: { title: string } }>(app, 'widget')).view.title).toBe('Budget review')
    await page.getByTestId('note-title').getByRole('button').click()
    await page.getByTestId('note-title-input').fill('Not this')
    await page.getByTestId('note-title-input').press('Escape')
    await expect(page.getByTestId('note-title')).toHaveText('Budget review')
    // from the menu too
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-rename').click()
    await page.getByTestId('note-title-input').fill('  Budget   plan ')
    await page.getByTestId('note-title-input').blur()
    await expect(page.getByTestId('note-title')).toHaveText('Budget plan')
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))!.title).toBe('Budget plan')
    await fake(app, 'go', '')
    await expect(page.getByTestId('past-note').first()).toContainText('Budget plan')
  } finally { await app.close() }
})

test('delete from the note menu: not while it records; to the Trash with Undo; deleted forever there, the note, its audio and its folder are gone', async () => {
  const { app, page, userData } = await launch()
  try {
    const id = await record(app, page)
    await heard(page, id)
    await page.getByTestId('note-menu-button').click()
    await expect(page.getByTestId('note-delete')).toBeDisabled()
    // main refuses too, whatever a page asks
    expect(await page.evaluate((id) => window.yogurt.meetings.delete(id), id)).toBe('recording')
    expect(await page.evaluate((id) => window.yogurt.meetings.trash(id), id)).toBe('recording')
    await page.keyboard.press('Escape')
    await stop(page)
    // while its notes are still being written: they stop with it
    await expect.poll(async () => (await notesOf(page, id)).status, { timeout: 30_000 }).not.toBe('idle')
    const dir = join(userData, 'meetings', id)
    expect(existsSync(dir)).toBe(true)
    // Delete: no question, the note closes, and it waits in the Trash with everything kept
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-delete').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('past-note')).toHaveCount(0)
    await expect(page.getByTestId('trash-toast')).toContainText('Moved to the Trash')
    expect(existsSync(dir)).toBe(true)
    // Undo: back in its note
    await page.getByTestId('trash-undo').click()
    await expect(page.getByTestId('note')).toBeVisible()
    await expect(page.getByTestId('note-trashed')).toHaveCount(0)
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.trashedAt).toBeUndefined()
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-delete').click()
    await expect(page.getByTestId('home')).toBeVisible()
    // Delete forever, from the Trash: asks first, Cancel focused
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('trash-row')).toHaveCount(1)
    await page.getByTestId('trash-row').hover()
    await page.getByTestId('trash-delete').click()
    await expect(page.getByTestId('delete-confirm')).toContainText('removed from this Mac for good')
    await expect(page.getByTestId('delete-cancel')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('delete-confirm')).toHaveCount(0)
    await expect(page.getByTestId('trash-delete')).toBeFocused()
    expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toBeDefined()
    await page.getByTestId('trash-delete').click()
    await page.getByTestId('delete-yes').click()
    await expect(page.getByTestId('trash-none')).toBeVisible()
    expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toBeUndefined()
    expect(await page.evaluate((id) => window.yogurt.transcript.get(id), id)).toEqual([])
    await expect.poll(() => existsSync(dir)).toBe(false)
    await page.waitForTimeout(1500)
    // nothing came back after: no notes job wrote into it, no folder made again
    expect(existsSync(dir)).toBe(false)
    expect(await page.evaluate(() => window.yogurt.search.query('Tuesday'))).toEqual([])
  } finally { await app.close() }
})

test('delete from a card on home moves it to the Trash at once; Undo brings it back', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'manyMeetings', 3)
    await page.reload()
    await expect(page.getByTestId('past-note')).toHaveCount(3)
    const title = (await page.getByTestId('past-note').first().locator('strong').textContent())!
    await page.getByTestId('past-note').first().hover()
    await page.getByTestId('past-note-more').first().click()
    await page.getByTestId('past-note-trash').click()
    await expect(page.getByTestId('delete-confirm')).toHaveCount(0)
    await expect(page.getByTestId('past-note')).toHaveCount(2)
    await expect(page.getByTestId('past-note').filter({ hasText: title })).toHaveCount(0)
    await expect(page.getByTestId('trash-toast')).toContainText('Moved to the Trash')
    await page.getByTestId('trash-undo').click()
    await expect(page.getByTestId('trash-toast')).toHaveCount(0)
    await expect(page.getByTestId('past-note')).toHaveCount(3)
    await expect(page.getByTestId('past-note').filter({ hasText: title })).toHaveCount(1)
  } finally { await app.close() }
})

test('odd messages from a page are ignored: nothing saved for them, and main never trips over them', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.evaluate(() => {
      const y = window.yogurt as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>
      y.notes.setMine(42, { md: 1 }); y.notes.setMine('no-such-meeting', 'hello'); y.notes.setEnhanced(null, 7)
      y.meetings.stop({}); y.chat.stop(5)
      void y.meetings.rename(1, 2); void y.meetings.delete('../..')
      void y.notes.writeAgain({}); void y.transcript.get(9); void y.prompt.act('explode')
    })
    await page.waitForTimeout(500)
    await expect(page.getByTestId('home')).toBeVisible()
    // nothing logged at all leaves no file
    const file = join(userData, 'logs', 'main.log')
    const log = existsSync(file) ? readFileSync(file, 'utf8') : ''
    expect(log).not.toMatch(/uncaught|unhandled|Error occurred in handler|FOREIGN KEY/i)
  } finally { await app.close() }
})
