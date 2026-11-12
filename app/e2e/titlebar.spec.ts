import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const region = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region')

test('the top strip drags the window on onboarding, the shell and a note', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_STEP_MS: '1000' } })
  try {
    const page = await app.firstWindow()
    const bar = page.getByTestId('titlebar')
    await expect(page.getByTestId('onboarding')).toBeVisible()
    expect(await bar.evaluate(region)).toBe('drag')
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 })
    expect(await bar.evaluate(region)).toBe('drag')
    // a note: start one from the call prompt, as a person would
    const start = Date.now() - 60_000
    await app.evaluate((_e, ev) => (globalThis as unknown as { __fake__: { signals(r: unknown): Promise<void> } }).__fake__.signals({ micApps: [{ bundleId: 'us.zoom.xos', name: 'zoom.us' }], events: [ev] }),
      { id: 'ev1', title: 'Design review', start, end: start + 30 * 60_000, attendees: [], url: 'https://zoom.us/j/1' })
    for (let i = 0; i < 100 && !app.windows().some((w) => w.url().includes('#prompt')); i++) await new Promise((r) => setTimeout(r, 50))
    await app.windows().find((w) => w.url().includes('#prompt'))!.getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note')).toBeVisible()
    expect(await bar.evaluate(region)).toBe('drag')
  } finally { await app.close() }
})

test('a minimum window at high zoom preserves Search and Ask without a follow-up shortcut', async () => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-zoom-')) } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await page.getByTestId('past-note').click()
    const wordmark = page.getByTestId('wordmark')
    const input = page.getByTestId('chat-input'), send = page.getByTestId('chat-send')
    await expect(wordmark).toBeVisible()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await expect(page.getByTestId('sidebar-expand')).toBeVisible()
    await expect(wordmark).toBeVisible()
    await page.getByTestId('chat-open').click()
    await expect(input).toHaveAttribute('placeholder', 'Ask anything')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.webContents.setZoomFactor(1.6))
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(600)
    await expect(wordmark).toBeVisible()
    const inputBox = (await input.boundingBox())!, action = (await send.boundingBox())!
    expect(inputBox.width).toBeGreaterThan(100)
    expect(action.x + action.width).toBeCloseTo(inputBox.x + inputBox.width, 1)
    expect(action.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height)
    const chat = (await page.getByTestId('chat-panel').boundingBox())!
    expect(chat.y).toBeCloseTo(16, 1)
    expect(await page.evaluate(() => innerHeight) - chat.y - chat.height).toBeCloseTo(16, 1)
    expect((await page.locator('.chat-history').boundingBox())!.height).toBeGreaterThan(0)
    expect(action.y + action.height).toBeLessThan(chat.y + chat.height)
    await input.press('Escape')
    await expect(page.getByTestId('chat-open')).toBeFocused()
    const search = page.getByTestId('search-open')
    const searchBox = (await search.boundingBox())!
    const moreBox = (await page.getByTestId('note-menu-button').boundingBox())!
    expect(searchBox.x + searchBox.width).toBeLessThan(moreBox.x)
    await search.click()
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await page.getByTestId('chat-open').click()
    await input.fill('What was decided?')
    await send.click()
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done')
    await page.getByTestId('chat-close').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.webContents.setZoomFactor(1))
    await page.getByTestId('sidebar-expand').click()
    await expect(wordmark).toBeVisible()
    await page.getByTestId('chat-open').click()
    await expect(input).toBeVisible()
    await expect(page.getByTestId('chat-follow-up')).toHaveCount(0)
  } finally { await app.close() }
})
