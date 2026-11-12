import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-editor-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(20))
  await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
  await page.getByTestId('note-notes-tab').click()
  return { app, page, id }
}

async function selectAll(page: Page, testId = 'note-mine') {
  await page.getByTestId(testId).focus()
  await page.getByTestId(testId).press('Meta+a')
  await expect(page.getByTestId('editor-toolbar')).toBeVisible()
}

test('the selection toolbar formats notes, reflects active marks, and keeps edits after reload', async () => {
  const { app, page, id } = await launch()
  try {
    const editor = page.getByTestId('note-mine')
    await editor.fill('Discuss the launch plan')
    await expect(page.getByTestId('editor-toolbar')).toHaveCount(0)
    await selectAll(page)
    const toolbar = page.getByTestId('editor-toolbar')
    await toolbar.getByRole('button', { name: 'Bold', exact: true }).click()
    await expect(editor.locator('strong')).toHaveText('Discuss the launch plan')
    await expect(toolbar.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await toolbar.getByRole('button', { name: 'Italic', exact: true }).click()
    await expect(editor.locator('em')).toHaveText('Discuss the launch plan')
    await toolbar.getByRole('button', { name: 'Heading', exact: true }).click()
    await expect(editor.locator('h2')).toHaveText('Discuss the launch plan')
    await toolbar.getByRole('button', { name: 'Bulleted list', exact: true }).click()
    await expect(editor.locator('ul li')).toHaveText('Discuss the launch plan')
    await toolbar.getByRole('button', { name: 'Numbered list', exact: true }).click()
    await expect(editor.locator('ol li')).toHaveText('Discuss the launch plan')
    await editor.press('Meta+z')
    await expect(editor.locator('ul li')).toHaveText('Discuss the launch plan')
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(n => n.mine), id)).toBe('- ***Discuss the launch plan***')
    await page.reload()
    await page.getByTestId('note-notes-tab').click()
    await expect(editor.locator('ul li strong em')).toHaveText('Discuss the launch plan')
    await selectAll(page)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(toolbar).toHaveCount(0)
  } finally { await app.close() }
})

test('toolbar supports keyboard focus and Escape; generating summaries remain read-only', async () => {
  const { app, page, id } = await launch()
  try {
    const editor = page.getByTestId('note-mine')
    await editor.fill('Follow up with the team')
    await selectAll(page)
    await editor.press('Alt+F10')
    const toolbar = page.getByTestId('editor-toolbar')
    await expect(toolbar.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(toolbar.getByRole('button', { name: 'Italic', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor.locator('em')).toHaveText('Follow up with the team')
    await page.keyboard.press('Escape')
    await expect(editor).toBeFocused()
    await expect(toolbar).toHaveCount(0)
    await editor.press('ArrowRight')
    await expect.poll(() => editor.evaluate(el => (el as HTMLElement & { editor: { state: { selection: { empty: boolean } } } }).editor.state.selection.empty)).toBe(true)
    await selectAll(page)
    await expect(toolbar).toBeVisible()
    await page.evaluate(id => window.yogurt.notes.writeAgain(id), id)
    await page.getByTestId('note-summary-tab').click()
    const summary = page.getByTestId('note-enhanced-editor')
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'writing')
    await expect(summary).toHaveAttribute('contenteditable', 'false')
    await expect(toolbar).toHaveCount(0)
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
    await selectAll(page, 'note-enhanced-editor')
    await toolbar.getByRole('button', { name: 'Bold', exact: true }).click()
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(n => n.edited), id)).toBe(true)
  } finally { await app.close() }
})
