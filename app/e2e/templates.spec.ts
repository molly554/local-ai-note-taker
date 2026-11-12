import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
/** the prompts that asked the stand-in model for a meeting's notes (not its title, nor anything else it is asked) */
const notesPrompts = async (app: ElectronApplication) => (await fake<{ notes: string[] }>(app, 'prompts')).notes.filter((p) => p.includes('Write the notes for this meeting'))

const CUSTOMER = 'This was a call with a customer or a possible customer.'
const INTERVIEW = 'This was a job interview.'
const TEAM = 'This was a team meeting.'
const NAMES = ['Any meeting', 'Team meeting', 'One-on-one', 'Customer call', 'Interview']

test('@everywhere Summary templates: picked in Settings for every meeting, and for one meeting from its Summary, which is then written again', async () => {
  // a recording and three Summaries, each written a few words at a time
  test.slow()
  const userData = mkdtempSync(join(tmpdir(), 'notetaker-templates-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  const settings = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  const menu = async () => { await page.getByTestId('note-view-menu').click(); await expect(page.getByTestId('note-templates')).toBeVisible() }
  const status = async () => { const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length); return (await page.evaluate((id) => window.yogurt.notes.get(id), id))?.status }
  /** the model was asked n times in all for this meeting's notes, and what it wrote last is saved and on screen */
  const written = async (n: number) => {
    await expect.poll(async () => (await notesPrompts(app)).length, { timeout: 60_000 }).toBe(n)
    await expect.poll(status, { timeout: 60_000 }).toBe('done')
    await expect(page.locator('[data-testid="note-enhanced"]:not(.streaming)')).toBeVisible()
  }
  const headings = () => page.getByTestId('note-enhanced-editor').locator('h2').allTextContents()
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('settings-open').click()

    // Settings → Summary starts as every Summary always was
    await page.getByTestId('summary-settings').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('settings-template')).toHaveValue('general')
    await expect(page.getByTestId('settings-template').locator('option')).toHaveText(NAMES)
    await expect(page.getByTestId('settings-next-steps-first')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('settings-notes-extra')).toHaveValue('')

    await page.getByTestId('settings-template').selectOption('customer')
    await page.getByTestId('settings-next-steps-first').click()
    await expect(page.getByTestId('settings-next-steps-first')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('settings-notes-extra').fill('  Keep it   under ten bullets ')
    await page.getByTestId('settings-notes-extra').press('Enter')
    // kept as one tidy line, and shown as it is kept
    await expect(page.getByTestId('settings-notes-extra')).toHaveValue('Keep it under ten bullets')
    await expect.poll(settings).toMatchObject({ template: 'customer', nextStepsFirst: true, notesExtra: 'Keep it under ten bullets' })

    // a meeting: its notes are asked for with the template, the next steps first and the request
    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toBeVisible({ timeout: 60_000 })
    await written(1)
    const first = await notesPrompts(app)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain(CUSTOMER)
    expect(first[0]).toContain('- First, before any topic, "## Next steps"')
    expect(first[0]).toContain('asks this of every summary: Keep it under ten bullets')
    // and the Summary on screen starts with them
    expect((await headings())[0]).toBe('Next steps')

    // its Summary's menu shows the template it was written with; picking the one it has writes nothing again
    await menu()
    await expect(page.getByTestId('note-templates').getByRole('menuitemradio')).toHaveText(NAMES)
    await expect(page.getByTestId('note-template-customer')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('note-template-customer').click()
    await expect(page.getByTestId('note-view-menu-list')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(await notesPrompts(app)).toHaveLength(1)

    // another one: written again with it, for this meeting only
    await menu()
    await page.getByTestId('note-template-interview').click()
    await written(2)
    const second = (await notesPrompts(app))[1]
    expect(second).toContain(INTERVIEW)
    expect(second).not.toContain(CUSTOMER)
    await menu()
    await expect(page.getByTestId('note-template-interview')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('note-template-customer')).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('note-view-menu-list')).toHaveCount(0)
    expect(settings().template).toBe('customer')

    // edits to the Summary are asked about first: Cancel keeps them and the template, the other button writes it again
    await page.getByTestId('note-enhanced-editor').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' and my own line')
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('and my own line')
    await menu()
    await page.getByTestId('note-template-team').click()
    await expect(page.getByTestId('note-confirm')).toBeVisible()
    await page.getByTestId('note-write-again-cancel').click()
    await expect(page.getByTestId('note-confirm')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(await notesPrompts(app)).toHaveLength(2)
    await expect(page.getByTestId('note-enhanced-editor')).toContainText('and my own line')
    await menu()
    await expect(page.getByTestId('note-template-interview')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('note-template-team').click()
    await expect(page.getByTestId('note-confirm')).toBeVisible()
    await page.getByTestId('note-write-again-confirm').click()
    await written(3)
    expect((await notesPrompts(app))[2]).toContain(TEAM)
    await expect(page.getByTestId('note-enhanced-editor')).not.toContainText('and my own line')
    await menu()
    await expect(page.getByTestId('note-template-team')).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app.close()
  }
})

test('@everywhere Summary templates: with nothing changed in Settings, a Summary is asked for and laid out as it always was', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'notetaker-templates-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-testid="note-enhanced"]:not(.streaming)')).toBeVisible({ timeout: 60_000 })
    const [prompt] = await notesPrompts(app)
    expect(prompt).toContain('- Last, "## Next steps"')
    for (const line of [CUSTOMER, INTERVIEW, TEAM, 'This was a one-on-one', 'asks this of every summary']) expect(prompt).not.toContain(line)
    expect(await page.getByTestId('note-enhanced-editor').locator('h2').allTextContents()).toEqual(['Launch plan', 'Release notes', 'Next steps'])
    // the menu marks the general template, the one in Settings
    await page.getByTestId('note-view-menu').click()
    await expect(page.getByTestId('note-template-general')).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app.close()
  }
})
