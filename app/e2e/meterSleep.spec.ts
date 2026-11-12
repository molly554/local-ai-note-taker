import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The meter's frame loop is most of the app's own work while recording: it runs only while it can be seen and something moves.
test('the level meter stops drawing while its window is hidden and once the room goes quiet', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-meter-')),
  } })
  app.context().setDefaultTimeout(15_000)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const wave = page.getByTestId('note-wave')
    // the fake mic talks for its first 16.5 s
    await expect(wave).toHaveAttribute('data-live', '1')
    await expect.poll(async () => Number(await wave.getAttribute('data-level'))).toBeGreaterThan(0.05)
    // hidden (minimised, or covered by another window): the loop stops, and new levels don't wake it
    const visibility = (state: 'hidden' | null) => page.evaluate((s) => {
      if (s) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
      else delete (document as { visibilityState?: string }).visibilityState
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
    await visibility('hidden')
    await expect(wave).toHaveAttribute('data-live', '0')
    await page.waitForTimeout(500)
    await expect(wave).toHaveAttribute('data-live', '0')
    await visibility(null)
    await expect(wave).toHaveAttribute('data-live', '1')
    // the fake mic falls silent: the meter settles at rest, still drawn, and the loop sleeps
    await expect(wave).toHaveAttribute('data-live', '0', { timeout: 30_000 })
    await expect(wave).toHaveAttribute('data-level', '0.00')
    expect(await wave.evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0))).toBe(true)
    await page.waitForTimeout(500)
    await expect(wave).toHaveAttribute('data-live', '0')
  } finally { await app.close() }
})
