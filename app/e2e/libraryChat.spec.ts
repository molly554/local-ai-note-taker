import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

test('asking across meetings from Chat: the answer streams in with sources that open the meeting at that line, and the chat is kept', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '80' })
  try {
    const [pricing] = await fake<string[]>(app, 'chatMeetings')
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(page.getByTestId('nav-chat')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    // Chat has its own box: no Ask Yogurt bar under it
    await expect(page.getByTestId('assistant-open')).toHaveCount(0)
    const input = page.getByTestId('chat-page-input')
    await expect(input).toBeFocused()
    await input.fill('Who said twenty dollars?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-question')).toHaveText('Who said twenty dollars?')
    const turn = page.getByTestId('chat-page-turn')
    await expect(turn).toHaveAttribute('data-status', 'answering', { timeout: 10_000 })
    await expect(page.getByTestId('chat-page-stop')).toBeVisible()
    await expect(page.getByTestId('chat-page-answer').locator('.fw').first()).toBeVisible()
    await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-page-answer')).toContainText('Pricing call')
    // Numbered marks reveal the retrieved source without leaving the answer.
    const chip = page.getByTestId('source-citation').first()
    await expect(chip).toHaveText('1')
    await expect(chip).toHaveAccessibleName(/Pricing call/)
    await chip.hover()
    await expect(page.getByTestId('citation-excerpt')).toContainText('Twenty dollars a seat')
    await expect(page.getByTestId('chat-page-answer')).not.toContainText('[1]')
    // the chat is saved, named after the question, and the address is its own
    expect((await page.evaluate(() => window.yogurt.conversations.list()))[0].title).toBe('Who said twenty dollars?')
    const route = await page.evaluate(() => window.yogurt.nav.current())
    expect(route).toMatch(/^\/chat\/[\w-]+$/)

    await chip.click()
    await page.getByTestId('citation-open').click()
    await expect(page.getByTestId('note')).toBeVisible()
    await expect(page.getByTestId('note-title')).toContainText('Pricing call')
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    const line = page.locator('[data-testid="transcript-line"][data-focused]')
    await expect(line).toHaveCount(1)
    // The generic fake answer has no sentence overlap, so the card selects the chunk's first line.
    await expect(line).toHaveAttribute('data-start', '0')
    await expect(line).toContainText('How much would fifty seats be?')
    await expect(line).toBeInViewport()
    expect(pricing).toBeTruthy()

    // back on the chat, after a reload too
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'done')
    await page.reload()
    await expect(page.getByTestId('chat-page-answer')).toContainText('Pricing call')
    await expect(page.getByTestId('source-citation').first()).toHaveText('1')
    await page.keyboard.press('Tab')
    await page.getByTestId('source-citation').first().focus()
    await expect(page.getByTestId('citation-excerpt')).toContainText('Twenty dollars a seat')
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('citation-open')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('citation-card')).toHaveCount(0)
    await expect(page.getByTestId('source-citation').first()).toBeFocused()
  } finally { await app.close() }
})

test('asking across meetings says it is reading what it found until the answer starts', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '3000' })
  try {
    await fake<string[]>(app, 'chatMeetings')
    await page.getByTestId('nav-chat').click()
    const input = page.getByTestId('chat-page-input')
    await input.fill('Who said twenty dollars?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-step')).toHaveText(/^Reading (\d+ meetings|.+)…$/)
    await expect(page.getByText('Looking through your meetings…')).toHaveCount(0)
    await page.getByTestId('chat-page-stop').click()
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'stopped')
  } finally { await app.close() }
})

test('a follow-up stays in the chat; New chat starts another; chats can be renamed and deleted', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '10' })
  try {
    await fake(app, 'chatMeetings')
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-starter')).toHaveCount(3)
    await expect(page.getByTestId('chat-starters')).toHaveCSS('flex-direction', 'row')
    await expect(page.getByTestId('chat-starters')).toHaveCSS('justify-content', 'center')
    await expect(page.getByTestId('chat-starter').first()).toHaveCSS('height', '28px')
    const suggestionBox = await page.getByTestId('chat-starters').boundingBox()
    const composerBox = await page.getByTestId('chat-page-box').boundingBox()
    expect(suggestionBox!.y - composerBox!.y - composerBox!.height).toBe(12)
    await page.getByTestId('chat-page-input').fill('What are my next steps?')
    await page.getByTestId('chat-page-input').press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    // The bubble treatment distinguishes Notes from timestamped transcript sources.
    await expect(page.getByTestId('source-citation').first()).toHaveText('1')
    await expect(page.getByTestId('source-citation').first()).toHaveAccessibleName(/Pricing call/)
    await page.getByTestId('source-citation').first().hover()
    await expect(page.locator('.citation-footer')).toContainText('Notes')
    await expect(page.getByTestId('citation-open')).toBeVisible()
    await page.keyboard.press('Escape')
    const input = page.getByTestId('chat-page-input')
    await input.fill('And the launch?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(2)
    await expect(page.getByTestId('chat-page-turn').last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    expect((await page.evaluate(() => window.yogurt.conversations.list())).filter(c => c.title)).toHaveLength(1)

    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-new').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill('When does the site go live?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-recent').click()
    // newest first
    await expect(page.getByTestId('chat-history-item')).toHaveCount(2)
    await expect(page.getByTestId('chat-history-item').first()).toContainText('When does the site go live?')

    const recentRow = page.locator('.ask-history-row').nth(1)
    const recentTime = recentRow.locator('time')
    await expect(recentTime).toHaveCSS('opacity', '1')
    await expect(recentRow.getByTestId('chat-menu')).toHaveCSS('opacity', '0')
    const timeBox = await recentTime.boundingBox()
    await page.getByTestId('chat-history-item').nth(1).hover()
    await expect(recentTime).toHaveCSS('opacity', '0')
    await expect(recentRow.getByTestId('chat-menu')).toHaveCSS('opacity', '1')
    expect(await recentTime.boundingBox()).toEqual({ ...timeBox, x: timeBox!.x - 2 })
    await page.locator('.ask-history-row').nth(1).getByTestId('chat-menu').click()
    await page.getByTestId('chat-rename').click()
    await page.getByTestId('chat-rename-input').fill('Weekly to-dos')
    await page.getByTestId('chat-rename-input').press('Enter')
    await page.getByTestId('chat-recent').click()
    await expect(page.getByTestId('chat-history-item').nth(1)).toContainText('Weekly to-dos')

    await page.getByTestId('chat-history-item').first().hover()
    await page.locator('.ask-history-row').first().getByTestId('chat-menu').click()
    await page.getByTestId('chat-delete').click()
    await expect(page.getByTestId('chat-delete-cancel')).toBeFocused()
    await page.getByTestId('chat-delete-yes').click()
    await page.getByTestId('chat-recent').click()
    await expect(page.getByTestId('chat-history-item')).toHaveCount(1)
    // the open chat was the one deleted: a new one
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    await page.getByTestId('chat-history-item').click()
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(2)
  } finally { await app.close() }
})

test('a stop keeps what was written; ⌘J from anywhere comes to Chat', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '300' })
  try {
    await fake(app, 'chatMeetings')
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    const input = page.getByTestId('chat-page-input')
    await input.fill('Who said twenty dollars?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-answer')).toContainText('Here', { timeout: 10_000 })
    await page.getByTestId('chat-page-stop').click()
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'stopped')
    await page.waitForTimeout(700)
    await expect(page.getByTestId('chat-page-answer')).not.toContainText('Launch planning')
    await page.reload()
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'stopped')
  } finally { await app.close() }
})

test('with no meetings, it says so instead of making something up', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '5' })
  try {
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-page-input').fill('What did Tarun say?')
    await page.getByTestId('chat-page-input').press('Enter')
    await expect(page.getByTestId('chat-page-answer')).toHaveText("I couldn't find that in your meetings.", { timeout: 10_000 })
    await expect(page.getByTestId('source-citation')).toHaveCount(0)
  } finally { await app.close() }
})

test('a meeting cited for several of its parts shows one mark, and an answer that found nothing shows none', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '5' })
  try {
    await fake(app, 'bigMeeting', 1000)
    await page.getByTestId('nav-chat').click()
    const input = page.getByTestId('chat-page-input')
    // the fake cites every part of the long meeting it was given
    await input.fill('Which line came up in the long meeting?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-page-answer')).toContainText('Long meeting')
    await expect(page.getByTestId('source-citation')).toHaveCount(1)
    await page.reload()
    await expect(page.getByTestId('source-citation')).toHaveCount(1)

    // nothing there answers it, and the fake cites all eight meetings anyway
    await fake(app, 'manyMeetings', 8)
    await page.getByTestId('chat-menu').click()
    await page.getByTestId('chat-new').click()
    // New chat navigates asynchronously; do not type into the outgoing conversation.
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill('What did we decide about politics?')
    await input.press('Enter')
    await expect(page.getByTestId('chat-page-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(page.getByTestId('chat-page-answer')).toHaveText('Nothing in your meetings is about that.')
    await expect(page.getByTestId('source-citation')).toHaveCount(0)
  } finally { await app.close() }
})
