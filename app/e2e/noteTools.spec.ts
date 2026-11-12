import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('meeting tools expose all copy choices, an anchored search, and a multiline chat composer', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-note-tools-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    const copy = page.getByTestId('share-button')
    await expect(page.locator('.note-header').getByTestId('share-button')).toHaveText('Copy')
    await copy.click()
    await expect(page.getByTestId('share-menu').getByRole('menuitem')).toHaveText(['Copy my notes', 'Copy summary', 'Copy transcript', 'Export as Markdown…'])
    await page.keyboard.press('Escape')
    await page.getByTestId('note-transcript-toggle').click()
    const search = page.getByTestId('transcript-search'), field = page.locator('.transcript-search-field')
    await expect(page.locator('.note-primary-tabs').getByTestId('transcript-search')).toBeVisible()
    const tabs = (await page.locator('.note-primary-tabs').boundingBox())!
    const compact = (await field.boundingBox())!
    expect(compact.x + compact.width).toBeCloseTo(tabs.x + tabs.width, 1)
    await expect(page.getByTestId('transcript-copy')).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await search.click()
    await expect(field).toHaveCSS('transition-duration', '0.22s, 0.22s, 0.14s, 0.14s')
    await expect.poll(async () => (await field.boundingBox())!.width).toBeGreaterThan(200)
    await page.getByTestId('note-transcript-toggle').click()
    await expect.poll(async () => (await field.boundingBox())!.width).toBeLessThan(120)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await search.click()
    await expect(field).toHaveCSS('transition-duration', '0s')
    await page.getByTestId('chat-open').click()
    const input = page.getByTestId('chat-input')
    await expect(input).toHaveJSProperty('tagName', 'TEXTAREA')
    await input.fill('What was decided?')
    await input.press('End')
    await input.press('Shift+Enter')
    await input.pressSequentially('And who owns it?')
    await expect(input).toHaveValue('What was decided?\nAnd who owns it?')
    await expect(page.getByTestId('chat-turn')).toHaveCount(0)
    await input.press('Enter')
    await expect(page.getByTestId('chat-question')).toHaveText('What was decided?\nAnd who owns it?')
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    await expect(page.getByTestId('chat-copy-answer')).toBeVisible()
  } finally { await app.close() }
})
