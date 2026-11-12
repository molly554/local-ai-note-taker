import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const focused = (input: Locator) => input.evaluate(el => document.activeElement === el)

// Sending must leave the person in the box: they keep typing through the whole answer.
async function keepsFocus(page: Page, prefix: string) {
  const input = page.getByTestId(`${prefix}-input`)
  await expect(input).toBeFocused()
  await input.pressSequentially('What was decided?')
  await input.press('Enter')
  const turn = page.getByTestId(`${prefix}-turn`).last()
  await expect(turn).toHaveAttribute('data-status', 'answering', { timeout: 10_000 })
  await expect(page.getByTestId(`${prefix}-input`)).toBeFocused()
  await page.keyboard.type('And next')
  await expect(page.getByTestId(`${prefix}-input`)).toHaveValue('And next')
  await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  expect(await focused(page.getByTestId(`${prefix}-input`))).toBe(true)
  await page.keyboard.type(' steps?')
  await expect(page.getByTestId(`${prefix}-input`)).toHaveValue('And next steps?')
  // A send from the button comes back to the box too, once the stop button takes its place.
  await page.getByTestId(`${prefix}-send`).click()
  await expect(page.getByTestId(`${prefix}-turn`).last()).toHaveAttribute('data-status', 'answering', { timeout: 10_000 })
  await expect(page.getByTestId(`${prefix}-input`)).toBeFocused()
  await expect(page.getByTestId(`${prefix}-turn`).last()).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await expect(page.getByTestId(`${prefix}-input`)).toBeFocused()
  // A deliberate click elsewhere keeps its focus.
  await page.getByTestId('chat-copy-answer').last().click()
  await expect(page.getByTestId('chat-copy-answer').last()).toBeFocused()
}

// pieces slow enough that a slow machine still sees an answer while it is being written
async function launch(name: string) {
  const app = await electron.launch({ args: [main], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_LLM_MS: '300', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), `yogurt-${name}-`)),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('the note panel keeps focus in the box through a whole answer', async () => {
  const { app, page } = await launch('ask-focus-panel')
  try {
    const meeting = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(5)) as string
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), meeting)
    await expect(page.getByTestId('chat-open')).toBeVisible()
    await page.keyboard.press('Meta+j')
    await keepsFocus(page, 'chat')
  } finally { await app.close() }
})

test('the Ask page keeps focus in the box through a whole answer', async () => {
  const { app, page } = await launch('ask-focus-page')
  try {
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    await keepsFocus(page, 'chat-page')
  } finally { await app.close() }
})

test('Back to latest floats 8px above the box in the panel and on the page', async () => {
  const { app, page } = await launch('ask-latest-gap')
  try {
    const meeting = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(5)) as string
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), meeting)
    await expect(page.getByTestId('chat-open')).toBeVisible()
    await page.keyboard.press('Meta+j')
    const input = page.getByTestId('chat-input')
    await input.fill('Hello'); await input.press('Enter')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    const view = await page.evaluate(async id => window.yogurt.conversations.get(await window.yogurt.conversations.current([{ kind: 'meeting', id }])), meeting)
    await app.evaluate(({ ipcMain }, view) => {
      ipcMain.removeHandler('conversations:get')
      ipcMain.handle('conversations:get', () => ({ ...view, turns: Array.from({ length: 30 }, (_, i) => ({
        id: i + 1, question: `Question ${i + 1}`, answer: 'A saved paragraph about the meeting. '.repeat(20), status: 'done', sources: [],
      })) }))
    }, view)
    await input.press('Escape'); await page.keyboard.press('Meta+j')
    const gap = async (prefix: string) => {
      await page.locator('.ask-thread').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
      await expect(page.getByTestId('chat-latest')).toBeVisible()
      const button = (await page.getByTestId('chat-latest').boundingBox())!
      const box = (await page.getByTestId(`${prefix}-box`).boundingBox())!
      expect(button.y + button.height).toBeLessThanOrEqual(box.y - 6)
    }
    await gap('chat')
    await page.getByTestId('chat-expand').click()
    await expect(page.getByTestId('chat-page-turn')).toHaveCount(30)
    await gap('chat-page')
  } finally { await app.close() }
})
