import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
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

test('Ask opens one contained panel, keeps the note usable, and restores focus when closed', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const trigger = page.getByTestId('chat-open'), panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    await expect(trigger).toBeVisible()
    await expect(input).toHaveCount(0)
    const closed = (await page.getByTestId('note-title').boundingBox())!
    await page.keyboard.press('Meta+j')
    await expect(panel).toBeVisible()
    await expect(input).toBeFocused()
    await expect(panel.getByTestId('chat-box')).toBeVisible()
    const reading = (await page.locator('.note-reading-area').boundingBox())!, panelBox = (await panel.boundingBox())!
    const composer = (await panel.locator('.chat-composer').boundingBox())!
    expect(await page.getByTestId('note-title').boundingBox()).toEqual(closed)
    expect(reading.y + reading.height - panelBox.y - panelBox.height).toBeCloseTo(12, 1)
    expect(await page.evaluate(() => innerWidth) - panelBox.x - panelBox.width).toBeCloseTo(24, 1)
    expect(panelBox.y + panelBox.height - composer.y - composer.height).toBeCloseTo(1, 1)
    await expect(page.locator('.note-footer').getByTestId('chat-open')).toContainText('⌘J')
    await expect(panel.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await expect(page.getByText('Write a follow-up email', { exact: true })).toHaveCount(0)
    await input.fill('A question to come back to')
    await page.getByTestId('note-title').click()
    await expect(panel).toBeVisible()
    await input.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(input).toHaveValue('A question to come back to')
    // Command-J resumes/focuses this conversation; Escape closes it.
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  } finally { await app.close() }
})

test('a narrow chat is modal, contains keyboard focus, and keeps its draft when widened', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('#'))!.setSize(720, 600))
    await page.getByTestId('chat-open').click()
    const panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(await panel.evaluate((el) => el.matches(':modal'))).toBe(true)
    await expect(input).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name: 'Add a meeting or folder' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await input.fill('Keep this draft')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('#'))!.setSize(1100, 760))
    await expect(panel).not.toHaveAttribute('aria-modal', 'true')
    expect(await panel.evaluate((el) => el.matches(':modal'))).toBe(false)
    await expect(input).toHaveValue('Keep this draft')
    await expect(input).toBeFocused()
    const note = (await page.locator('.note-content:visible').boundingBox())!, chat = (await panel.boundingBox())!
    expect(note.x + note.width).toBeGreaterThan(chat.x)
    await input.press('Escape')
    await expect(page.getByTestId('chat-open')).toBeFocused()
  } finally { await app.close() }
})

test('asking about a finished meeting streams the answer in, word by word, and it is still there after a reload', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '80' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 30)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toHaveAttribute('placeholder', 'Ask anything')
    // Keep the action slot reserved even before there is a question to send.
    await expect(page.getByTestId('chat-send')).toBeDisabled()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    await input.click()
    // a few common questions to start from
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await input.fill('When does the site go live?')
    await input.press('Enter')
    await expect(input).toHaveValue('')
    const turn = page.getByTestId('chat-turn')
    await expect(page.getByTestId('chat-question')).toHaveText('When does the site go live?')
    await expect(turn).toHaveAttribute('data-status', 'answering', { timeout: 10_000 })
    // the stop button while it writes; new words fade in
    await expect(page.getByTestId('chat-stop')).toBeVisible()
    await expect(page.getByTestId('chat-stop')).toHaveAccessibleName('Stop')
    // a quiet grey stop with an ink square, so typing ahead never looks ready to send
    await expect(page.getByTestId('chat-stop')).toHaveCSS('color', 'rgb(28, 31, 35)')
    await expect(page.getByTestId('chat-answer').locator('.fw').first()).toBeVisible()
    await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    const answer = page.getByTestId('chat-answer')
    await expect(answer).toContainText('The launch plan, in short:')
    await expect(answer.locator('li')).toHaveCount(2)
    await expect(answer.locator('strong')).toHaveText('Tuesday')
    await expect(page.getByTestId('chat-stop')).toHaveCount(0)
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await input.press('Escape')
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await page.getByTestId('chat-open').click()
    // Transcript and chat stay available together; the completed answer is announced once.
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('chat-announce')).toContainText('The launch plan, in short:')
    await page.getByTestId('note-title').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    await page.reload()
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('chat-answer')).toContainText('The site goes live on Tuesday.')

    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-new').click()
    await expect(page.getByTestId('chat-turn')).toHaveCount(0)
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await expect(page.getByTestId('chat-input')).toBeFocused()
    expect((await page.evaluate((id) => window.yogurt.chat.get(id), id)).turns).toEqual([])
  } finally { await app.close() }
})

test('opening Ask on a meeting reads it in ahead, and a question says what it is doing until the answer starts', async () => {
  // a first word well after the 4s step tick, so a slow machine still sees each step
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '8000' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 12)
    await fake(app, 'go', `/note/${id}`)
    const title = (await page.getByTestId('note-title').textContent())!.trim()
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toBeFocused()
    // the meeting's transcript and notes are read into the model before anything is asked, once for repeated opens
    await expect.poll(async () => (await fake<{ preloads: string[] }>(app, 'prompts')).preloads.length).toBeGreaterThan(0)
    const read = (await fake<{ preloads: string[] }>(app, 'prompts')).preloads.at(-1)!
    expect(read).toContain(`Meeting: ${title}`)
    await input.blur(); await input.focus()
    await input.fill('When does the site go live?')
    await input.press('Enter')
    const step = page.getByTestId('chat-step')
    await expect(step).toHaveText(`Reading ${title}…`)
    await expect(step).toHaveText(`Still reading ${title}…`, { timeout: 6000 })
    expect((await fake<{ notes: string[] }>(app, 'prompts')).notes.find((p) => p.includes('When does the site go live?'))!.startsWith(read)).toBe(true)
    expect((await fake<{ preloads: string[] }>(app, 'prompts')).preloads.filter((p) => p === read)).toHaveLength(1)
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(step).toHaveCount(0)
  } finally { await app.close() }
})

test('during a recording it answers from the transcript so far, and a stop keeps what was written', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '250' })
  try {
    await fake(app, 'signals', { micApps: [], events: [] })
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('chat-open').click()
    // questions that fit a meeting still going on
    await page.getByTestId('chat-suggestion').filter({ hasText: 'What did I just miss?' }).click()
    await expect(page.getByTestId('chat-question')).toHaveText('What did I just miss?')
    await expect(page.getByTestId('chat-answer')).toContainText('So far,', { timeout: 10_000 })
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-stop')).toHaveCount(0)
    await page.waitForTimeout(600)
    await expect(page.getByTestId('chat-answer')).not.toContainText('Wednesday')
    // stopped stays stopped
    await page.reload()
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
  } finally { await app.close() }
})

test('the suggestions can be reached and picked with the keyboard', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '20' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await expect(page.getByTestId('chat-input')).toBeFocused()
    // Suggestions sit above the context strip and composer.
    await page.keyboard.press('Shift+Tab') // remove context
    await page.keyboard.press('Shift+Tab') // third suggestion
    await page.keyboard.press('Shift+Tab') // second suggestion
    await page.keyboard.press('Shift+Tab') // first suggestion
    await expect(page.getByTestId('chat-suggestion').first()).toBeFocused()
    await expect(page.locator('[data-testid=chat-suggestion]:visible')).toHaveCount(3)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    // links an answer has are shown as plain text, never followed
    await expect(page.getByTestId('chat-answer')).toContainText('the launch page')
    await expect(page.getByTestId('chat-answer').locator('a')).toHaveCount(0)
  } finally { await app.close() }
})

test('the composer has no follow-up shortcut and keeps its input and send action in place while asking and stopping', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '250' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const input = page.getByTestId('chat-input')
    const action = page.locator('[data-testid="chat-send"], [data-testid="chat-stop"]')
    await page.getByTestId('chat-open').click()
    await expect(input).toBeVisible()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    const initialInput = (await input.boundingBox())!, initialAction = (await action.boundingBox())!
    // The send action lives inside the roomy composer, below its text area.
    expect(initialAction.y).toBeGreaterThanOrEqual(initialInput.y + initialInput.height)
    const stable = async () => {
      const nextInput = (await input.boundingBox())!
      expect(nextInput.width).toBeCloseTo(initialInput.width, 1)
      const nextAction = (await action.boundingBox())!
      expect(nextAction.x).toBeCloseTo(initialAction.x, 1)
      expect(nextAction.width).toBeCloseTo(initialAction.width, 1)
    }
    await input.fill('When does the site go live?')
    await stable()
    await input.press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'answering')
    await stable()
    await page.getByTestId('chat-stop').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    await expect(page.getByTestId('chat-send')).toBeDisabled()
    await stable()
  } finally { await app.close() }
})

test('an unacknowledged question cannot be sent twice, and a rejected request keeps it ready to retry', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await app.evaluate(({ ipcMain }) => {
      const state = { calls: 0, reject: () => {} }
      ;(globalThis as unknown as { __chatRequestTest: typeof state }).__chatRequestTest = state
      ipcMain.removeHandler('conversations:ask')
      ipcMain.handle('conversations:ask', () => {
        state.calls++
        return new Promise((_resolve, reject) => { state.reject = () => reject(new Error('request failed')) })
      })
    })
    const input = page.getByTestId('chat-input'), send = page.getByTestId('chat-send')
    await page.getByTestId('chat-open').click()
    await input.fill('Who owns the release notes?')
    await input.press('Enter')
    await expect(input).toHaveValue('Who owns the release notes?')
    await expect(input).not.toBeEditable()
    await expect(input).toBeFocused()
    await expect(send).toBeDisabled()
    expect(await app.evaluate(() => (globalThis as unknown as { __chatRequestTest: { calls: number } }).__chatRequestTest.calls)).toBe(1)
    await app.evaluate(() => (globalThis as unknown as { __chatRequestTest: { reject(): void } }).__chatRequestTest.reject())
    await expect(page.getByTestId('chat-send-error')).toHaveText("Couldn't save your changes")
    await expect(input).toHaveValue('Who owns the release notes?')
    await expect(send).toBeEnabled()
    await input.press('Escape')
    await expect(page.getByTestId('chat-send-error')).toHaveCount(0)
    await expect(page.getByTestId('chat-open')).toBeFocused()
    await page.getByTestId('chat-open').click()
    await expect(input).toHaveValue('Who owns the release notes?')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(input).toHaveValue('Who owns the release notes?')
    await input.click()
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(input).toHaveValue('Who owns the release notes?')
    const current = await page.evaluate(async id => window.yogurt.conversations.get(await window.yogurt.conversations.current([{ kind: 'meeting', id }])), id)
    await app.evaluate(({ ipcMain, BrowserWindow }, current) => {
      ipcMain.removeHandler('conversations:ask')
      ipcMain.handle('conversations:ask', (_event, id: string, question: string) => {
        const view = { ...current, id, draft: '', turns: [{ id: 1, question, answer: 'Bo owns the release notes.', status: 'done', sources: [] }], waitsForMeeting: false, waitsForModel: false }
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('conversations:changed', view)
        return id
      })
    }, current)
    await send.click()
    await expect(page.getByTestId('chat-send-error')).toHaveCount(0)
    await expect(page.getByTestId('chat-answer')).toHaveText('Bo owns the release notes.')
    await expect(send).toBeDisabled()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
  } finally { await app.close() }
})


test('Ask grows out of its button without stretching its content, preserves its draft, and respects reduced motion', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const trigger = page.getByTestId('chat-open')
    await trigger.click()
    // only the surface stretches out of the button; the chat inside keeps its size
    const shell = page.locator('.chat-morph-surface')
    const frames = await shell.evaluate((el) => el.getAnimations().map(a => (a.effect as KeyframeEffect).getKeyframes()).find(k => k.some(f => f.transform)))
    expect(frames?.at(-1)?.transform).toBe('none')
    await expect(page.locator('.chat-panel-contents')).toHaveCSS('transform', 'none')
    await expect(page.locator('.chat-panel-contents')).toHaveCSS('filter', 'none')
    await page.getByTestId('chat-input').fill('Keep this thought')
    await page.getByTestId('chat-close').click()
    await expect(page.getByTestId('chat-panel')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-input')).toBeFocused()
    // ⌘J grows it out of the button too
    expect(await shell.evaluate(el => el.getAnimations().length)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-input')).toHaveValue('Keep this thought')
    expect(await shell.evaluate((el) => el.getAnimations().length)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  } finally { await app.close() }
})

for (const width of [1100, 720]) test(`Command-J focuses Ask from any focus at ${width}px and still opens Chat elsewhere`, async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 760), width)
    const id = await fake<string>(app, 'bigMeeting', 10)
    await fake(app, 'go', `/note/${id}`)
    const trigger = page.getByTestId('chat-open'), panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    await expect(trigger).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    await input.fill('Keep my draft')
    await page.keyboard.press('Meta+j')
    await expect(panel).toBeVisible()
    await expect(input).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Meta+j')
    await expect(input).toHaveValue('Keep my draft')
    await page.getByTestId('chat-menu').focus()
    await page.keyboard.press('Meta+j')
    await expect(input).toBeFocused()
    if (width === 1100) {
      await page.getByTestId('note-title').click()
      await page.keyboard.press('Meta+j')
      await expect(input).toBeFocused()
    }
    await page.keyboard.press('Escape')
    await fake(app, 'go', '')
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(page.locator('#library-question')).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(page.locator('#library-question')).toBeFocused()
  } finally { await app.close() }
})
