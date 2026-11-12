import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a continuous scrub follows smoothly, settles on release and gives manual scrolling back', async ({}, info) => {
  const review = process.env.YOGURT_SCRUB_REVIEW === 'before' ? 'before' : 'after'
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-scrub-motion-')),
  }, ...(process.env.CI ? { recordVideo: { dir: info.outputPath('scrub-motion', review), size: { width: 1100, height: 760 } } } : {}) })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
    await app.evaluate(() => {
      const fake = (globalThis as unknown as { __fake__: { bigMeeting(n: number): string; go(route: string): void } }).__fake__
      fake.go(`/note/${fake.bigMeeting(400)}`)
    })
    await page.getByTestId('note-transcript-toggle').click()
    const scrubber = page.getByTestId('player-scrubber'), list = page.getByTestId('transcript')
    await expect(scrubber).toBeVisible()
    await expect.poll(() => scrubber.getAttribute('max')).not.toBe('0')
    await scrubber.fill('40')
    const comfy = () => page.evaluate(() => {
      const list = document.querySelector('[data-testid="transcript"]')!.getBoundingClientRect()
      const line = document.querySelector('[data-testid="transcript-line"][data-playing]')!.getBoundingClientRect()
      return line.top > list.top && line.top < list.top + list.height * .7
    })
    await expect.poll(comfy).toBe(true)
    await page.waitForTimeout(400)
    const box = (await scrubber.boundingBox())!, y = box.y + box.height / 2
    const x = (share: number) => box.x + 6 + (box.width - 12) * share
    // The same timed pointer path is also used by the one-off baseline CI capture.
    await page.mouse.move(x(.2), y)
    await page.mouse.down()
    const forward: number[] = []
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(x(.2 + .5 * i / 40), y)
      await page.waitForTimeout(40)
      forward.push(await list.evaluate(el => el.scrollTop))
    }
    await page.mouse.up()
    await expect.poll(comfy).toBe(true)
    expect(forward.at(-1)! - forward[0]).toBeGreaterThan(1000)
    if (review !== 'before') expect(forward.every((top, i) => !i || top >= forward[i - 1] - 1)).toBe(true)
    await page.waitForTimeout(400)
    await page.mouse.down()
    for (let i = 1; i <= 24; i++) {
      await page.mouse.move(x(.7 - .25 * i / 24), y)
      await page.waitForTimeout(40)
    }
    await page.mouse.up()
    await expect.poll(comfy).toBe(true)
    await page.waitForTimeout(400)
    const settled = await list.evaluate(el => el.scrollTop)
    await page.waitForTimeout(350)
    expect(await list.evaluate(el => el.scrollTop)).toBe(settled)
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
    mkdirSync(info.outputPath('scrub-motion'), { recursive: true })
    await page.screenshot({ path: info.outputPath('scrub-motion', `${review}.png`) })

    // A wheel gesture interrupts a seek still in flight; its deferred frames cannot pull the list back.
    await scrubber.fill('100')
    const bounds = (await list.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeLessThan(40)
    await page.waitForTimeout(400)
    expect(await list.evaluate(el => el.scrollTop)).toBeLessThan(40)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await scrubber.fill('80')
    await expect.poll(comfy).toBe(true)
    const reduced = await list.evaluate(el => el.scrollTop)
    await page.waitForTimeout(100)
    expect(await list.evaluate(el => el.scrollTop)).toBe(reduced)
  } finally { await app.close() }
})
