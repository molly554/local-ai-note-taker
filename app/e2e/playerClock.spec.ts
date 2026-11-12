import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a pending seek keeps its requested position when an older media clock update arrives', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-player-clock-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(() => {
      const fake = (globalThis as unknown as { __fake__: { bigMeeting(n: number): string; go(route: string): void } }).__fake__
      fake.go(`/note/${fake.bigMeeting(120)}`)
    })
    await page.getByTestId('note-transcript-toggle').click()
    const scrubber = page.getByTestId('player-scrubber'), lead = page.getByTestId('player-audio-me')
    await expect.poll(() => scrubber.getAttribute('max')).toBe('60')
    await scrubber.fill('52')
    await expect.poll(() => lead.evaluate((el: HTMLAudioElement) => !el.seeking && el.currentTime === 52)).toBe(true)
    await lead.evaluate((el: HTMLAudioElement) => {
      // Model Chromium delivering its previous clock while a newer seek is still pending.
      Object.defineProperty(el, 'seeking', { configurable: true, value: true })
      Object.defineProperty(el, 'currentTime', { configurable: true, value: 40 })
      el.dispatchEvent(new Event('timeupdate'))
    })
    await expect(scrubber).toHaveValue('52')
    await expect(page.locator('[data-testid="transcript-line"][data-playing]')).toHaveAttribute('data-start', '52000')
    await lead.evaluate((el: HTMLAudioElement) => {
      Reflect.deleteProperty(el, 'seeking'); Reflect.deleteProperty(el, 'currentTime')
      el.currentTime = 53
    })
    await expect.poll(() => lead.evaluate((el: HTMLAudioElement) => !el.seeking && el.currentTime === 53)).toBe(true)
    await lead.evaluate(el => el.dispatchEvent(new Event('timeupdate')))
    await expect(scrubber).toHaveValue('53')
    await expect(page.locator('[data-testid="transcript-line"][data-playing]')).toHaveAttribute('data-start', '53000')
  } finally { await app.close() }
})
