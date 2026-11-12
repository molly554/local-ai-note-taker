import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CI only: this Mac's local E2E guard remains in force.
test('Ask shares meeting history and drafts, and Command-J starts the right context', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-ask-context-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const meeting = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(5)) as string
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), meeting)
    await expect(page.getByTestId('chat-open')).toBeVisible()
    await page.keyboard.press('Meta+j')
    const input = page.getByTestId('chat-input')
    await expect(input).toBeFocused()
    await expect(page.locator('.ask-box .ask-context-row')).toHaveCount(1)
    await expect(page.locator('.ask-context-row')).toHaveCSS('height', '32px')
    await page.evaluate(id => window.yogurt.meetings.rename(id, 'Design review with LT'), meeting)
    await expect(page.locator('.ask-context-row')).toContainText('Design review with LT')
    await expect(page.getByTestId('ask-composer-context')).toHaveCSS('box-shadow', 'none')
    await input.fill('What was decided?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.locator('.ask-box .ask-context-row')).toHaveCount(1)
    await expect(page.getByTestId('ask-thread-context')).toHaveCount(0)
    await input.fill('Keep this question for later')
    await input.press('Escape')
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-recent').click()
    await page.getByTestId('chat-history-item').filter({ hasText: 'What was decided?' }).click()
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(1)
    await expect(page.getByTestId('chat-page-input')).toHaveValue('Keep this question for later')
    await expect(page.locator('.ask-box .ask-context-row')).toHaveCount(1)
    await page.locator('.ask-context-row button').focus()
    await page.locator('.ask-context-row button').press('Enter')
    await expect(page.getByTestId('ask-composer-context')).toHaveCount(0)
    await expect(page.getByTestId('chat-page-input')).toBeFocused()
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(1)
    await page.reload()
    await expect(page.getByTestId('chat-page-input')).toHaveValue('Keep this question for later')
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(0)
    await expect(page.locator('.ask-box .ask-context-row')).toHaveCount(0)
    const title = await page.evaluate(id => window.yogurt.meetings.get(id).then(v => v!.title), meeting)
    await page.getByTestId('chat-page-input').fill(`@${title}`)
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.getByTestId('chat-page-input').press('Enter')
    await expect(page.locator('.ask-box .ask-context-row')).toContainText(title)
    await expect(page.getByTestId('chat-page-input')).toHaveValue('')
    await page.locator('.ask-box .ask-context-row button').click()
    await expect(page.locator('.ask-box .ask-context-row')).toHaveCount(0)
  } finally { await app.close() }
})

test('the note panel and full conversation expose Rename and a single Delete confirmation', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_LLM_MS: '10', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-ask-actions-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const [meeting] = await app.evaluate(() => (globalThis as any).__fake__.chatMeetings()) as string[]
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), meeting)
    await expect(page.getByTestId('chat-open')).toBeVisible()
    // Exercise menus and confirmation inside the native modal panel, too.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 760))
    await page.keyboard.press('Meta+j')
    await expect(page.locator('.chat-panel .ask-conversation-head')).toHaveCount(1)
    // Global retrieval supplies cited chunks; single-meeting answers use the whole transcript.
    await page.locator('.ask-context-row button').click()
    await page.getByTestId('chat-input').fill('What are my next steps?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    const citation = page.getByTestId('source-citation').first()
    await citation.hover()
    await expect(page.getByTestId('citation-card')).toBeVisible()
    await page.keyboard.press('Escape') // The composer still has focus after hover.
    await expect(page.getByTestId('citation-card')).toHaveCount(0)
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.keyboard.press('Tab')
    await citation.focus()
    await expect(page.getByTestId('citation-card')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('citation-open')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(citation).toBeFocused()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-rename').click()
    await page.getByTestId('chat-rename-input').fill('Decisions')
    await page.getByTestId('chat-rename-input').press('Enter')
    await expect(page.locator('#meeting-chat-title')).toHaveText('Decisions')
    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-delete').click()
    await expect(page.getByTestId('chat-delete-confirm')).toHaveCount(1)
    await page.getByTestId('chat-delete-cancel').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-recent').click()
    await page.getByTestId('chat-history-item').filter({ hasText: 'Decisions' }).click()
    await expect(page.locator('.ask-conversation-head h2')).toHaveText('Decisions')
    await page.locator('.ask-conversation-head').getByTestId('chat-menu').click()
    await page.getByTestId('chat-delete').click()
    await page.getByTestId('chat-delete-yes').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    expect((await page.evaluate(() => window.yogurt.conversations.list())).some(c => c.title === 'Decisions')).toBe(false)
  } finally { await app.close() }
})

test('Ask has soft thread edges, compact bubbles, and expands the same reading position', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_LLM_MS: '10', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-ask-edges-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const meeting = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(5)) as string
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), meeting)
    await expect(page.getByTestId('chat-open')).toBeVisible()
    await page.keyboard.press('Meta+j')
    const panel = page.getByTestId('chat-panel'), input = page.getByTestId('chat-input')
    await expect(panel).toHaveCSS('width', '420px')
    await expect(panel.locator('.ask-conversation-head')).toHaveCSS('border-bottom-width', '0px')
    await expect(panel.locator('.ask-composer')).toHaveCSS('border-top-width', '0px')
    await expect(page.getByTestId('chat-suggestion')).toHaveCount(3)
    const suggestions = await page.getByTestId('chat-suggestion').all()
    const boxes = await Promise.all(suggestions.map(s => s.boundingBox()))
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y + boxes[i - 1]!.height)
      expect(boxes[i]!.x + boxes[i]!.width).toBeCloseTo(boxes[0]!.x + boxes[0]!.width, 1)
    }
    await input.fill('Hello'); await input.press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-question')).toHaveCSS('height', '36px')
    await expect(page.getByTestId('chat-question')).toHaveCSS('padding', '8px 12px')
    await expect(panel.locator('.ask-context-row')).toHaveCount(1)
    await expect(page.getByTestId('chat-suggestion')).toHaveCount(0)
    const view = await page.evaluate(async id => window.yogurt.conversations.get(await window.yogurt.conversations.current([{ kind: 'meeting', id }])), meeting)
    // Long saved content makes both viewports overflow without a model-dependent answer length.
    await app.evaluate(({ ipcMain }, view) => {
      ipcMain.removeHandler('conversations:get')
      ipcMain.handle('conversations:get', () => ({ ...view, draft: 'Keep my draft', turns: Array.from({ length: 30 }, (_, i) => ({
        id: i + 1, question: `Question ${i + 1}`, answer: 'A saved paragraph about the meeting. '.repeat(20), status: 'done', sources: [],
      })) }))
    }, view)
    // Escape folds Ask back into its button; reopening after that loads the saved draft
    await input.press('Escape'); await expect(panel).toHaveCount(0); await page.keyboard.press('Meta+j')
    await expect(input).toHaveValue('Keep my draft')
    const thread = panel.locator('.ask-thread')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await thread.evaluate(el => { el.scrollTop = 200 })
      await expect.poll(() => thread.evaluate(el => getComputedStyle(el).maskImage)).toContain('linear-gradient')
    }
    await expect(page.getByTestId('chat-latest')).toBeVisible()
    await page.getByTestId('chat-expand').click()
    await expect(panel).toHaveCount(0)
    await expect(page.getByTestId('chat-page-input')).toHaveValue('Keep my draft')
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(30)
    await expect.poll(() => page.locator('.ask-thread').evaluate(el => el.scrollTop)).toBeCloseTo(200, 0)
    expect(await page.evaluate(() => window.yogurt.nav.current())).toBe(`/chat/${view!.id}`)
    await page.getByTestId('chat-latest').click()
    await expect(page.getByTestId('chat-latest')).toHaveCount(0)
  } finally { await app.close() }
})

test('Ask anchors context growth and retains picker results between searches', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-ask-layout-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    for (const title of ['Project review', 'Team planning', 'Launch notes']) {
      const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(2)) as string
      await page.evaluate(({ id, title }) => window.yogurt.meetings.rename(id, title), { id, title })
    }
    const targets = await page.evaluate(() => window.yogurt.conversations.targets(''))
    await app.evaluate(({ ipcMain }, targets) => {
      ipcMain.removeHandler('conversations:targets')
      ipcMain.handle('conversations:targets', async (_event, query: string) => {
        await new Promise(resolve => setTimeout(resolve, 180))
        return targets.filter(target => target.title.toLowerCase().includes(query.toLowerCase()))
      })
    }, targets)
    await page.getByTestId('nav-chat').click()
    const input = page.getByTestId('chat-page-input'), title = page.locator('.ask-home-title'), composer = page.locator('.ask-composer')
    await expect(input).toBeEnabled()
    const top = await title.boundingBox(), composerTop = (await composer.boundingBox())!.y
    await input.fill('@')
    await expect(page.getByRole('option')).toHaveCount(3)
    await expect(page.getByRole('group', { name: 'Folders', exact: true })).toHaveCount(0)
    await page.locator('.ask-picker').evaluate(el => {
      el.dataset.emptyFrame = 'false'
      const observer = new MutationObserver(() => { if (!el.querySelector('[role=option]')) el.dataset.emptyFrame = 'true' })
      observer.observe(el, { childList: true, subtree: true })
    })
    await input.fill('@p'); await input.fill('@pr')
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.locator('.ask-picker')).toHaveAttribute('data-empty-frame', 'false')
    for (const [index, name] of ['Project review', 'Team planning', 'Launch notes'].entries()) {
      await input.fill(`@${name}`)
      await expect(page.getByRole('option')).toHaveCount(1)
      await expect(page.getByRole('option')).toContainText(name)
      await input.press('Enter')
      await expect(page.locator('.ask-context-row')).toHaveCount(index + 1)
      await expect(input).toHaveValue('')
      expect(await title.boundingBox()).toEqual(top)
      expect((await composer.boundingBox())!.y).toBe(composerTop)
    }
    await input.fill('@no-match')
    await expect(page.locator('.ask-picker')).toContainText('Nothing found')
    await expect(page.locator('.ask-picker h3')).toHaveCount(0)
  } finally { await app.close() }
})
