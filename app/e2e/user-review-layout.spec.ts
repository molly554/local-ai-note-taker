import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('primary views keep their heading aligned, with room below the window toolbar', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-layout-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    await expect(page.getByTestId('note-enhanced-editor').locator('h2').first()).toHaveText('Budget')
    const initialTitle = await page.getByTestId('note-title').boundingBox()
    for (const chat of [false, true]) {
      if (chat) await page.getByTestId('chat-open').click()
      const before = (await page.getByTestId('note-title').boundingBox())!
      expect(before).toEqual(initialTitle)
      const toolbar = (await page.getByTestId('titlebar').boundingBox())!
      expect(before.y - toolbar.y - toolbar.height).toBeGreaterThanOrEqual(16)
      await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
      await expect(page.getByTestId('transcript-panel')).toBeVisible()
      const transcript = (await page.getByTestId('transcript-panel').boundingBox())!
      const inset = await page.getByTestId('transcript').evaluate(el => parseFloat(getComputedStyle(el).paddingInlineStart))
      expect(transcript.x + inset).toBeCloseTo(before.x, 0)
      const after = (await page.getByTestId('note-title').boundingBox())!
      expect(after.x).toBeCloseTo(before.x, 1)
      expect(after.y).toBeCloseTo(before.y, 1)
      if (chat) {
        const panel = (await page.getByTestId('chat-panel').boundingBox())!
        expect(transcript.x + transcript.width).toBeGreaterThan(panel.x)
      }
      await page.getByRole('tab', { name: 'My notes', exact: true }).click()
      const restored = (await page.getByTestId('note-title').boundingBox())!
      expect(restored.x).toBeCloseTo(before.x, 1)
      expect(restored.y).toBeCloseTo(before.y, 1)
    }
  } finally { await app.close() }
})
