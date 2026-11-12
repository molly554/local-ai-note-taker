import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const colorScheme of ['light', 'dark'] as const) test(`transcript fades directly below the tabs without moving text (${colorScheme})`, async ({}, testInfo) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-transcript-edge-')),
  } })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(100))
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByTestId('note-transcript-toggle').click()
    const list = page.getByTestId('transcript')
    await expect(page.getByTestId('transcript-line')).toHaveCount(100)
    const tabs = (await page.locator('.note-primary-tabs').boundingBox())!
    expect(Math.abs((await list.boundingBox())!.y - tabs.y - tabs.height)).toBeLessThan(2)
    await list.evaluate(el => { el.scrollTop = 120 })
    await expect.poll(() => list.evaluate(el => getComputedStyle(el).getPropertyValue('--scroll-fade-top').trim())).toBe('1.0000')
    expect(await list.evaluate(el => getComputedStyle(el).maskImage)).toContain('linear-gradient')
    expect(await page.getByTestId('transcript-turn').first().evaluate(el => ({ scale: getComputedStyle(el).scale, filter: getComputedStyle(el).filter }))).toEqual({ scale: 'none', filter: 'none' })
    await page.screenshot({ path: testInfo.outputPath(`transcript-edge-${colorScheme}.png`) })
    await list.evaluate(el => { el.scrollTop = 0 })
    await expect.poll(() => list.evaluate(el => getComputedStyle(el).getPropertyValue('--scroll-fade-top').trim())).toBe('0.0000')
    await expect(page.getByTestId('transcript-line').first()).toBeVisible()
  } finally { await app.close() }
})
