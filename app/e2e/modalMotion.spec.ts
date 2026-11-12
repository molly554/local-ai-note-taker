import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shared dialogs use the animated shell, keep focus safe, and dismiss without opening commands', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-modal-motion-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const trigger = page.getByTestId('folder-create')
    await trigger.click()
    const modal = page.getByTestId('folder-name')
    await expect(modal).toBeVisible()
    await expect.poll(() => modal.locator('.dialog-motion-surface').evaluate(el => el.getAnimations().length)).toBe(1)
    const motion = await modal.evaluate(async el => {
      const shell = el.querySelector<HTMLElement>('.dialog-motion-surface')!
      const content = el.querySelector<HTMLElement>('.dialog-motion-content')!
      const animation = shell.getAnimations()[0]
      const timing = animation.effect!.getTiming()
      // Seek the real animation so a busy CI worker cannot miss its short opening.
      animation.pause()
      const samples = []
      for (const time of [0, 280 * .72, 280]) {
        animation.currentTime = time
        await new Promise(requestAnimationFrame)
        const shape = getComputedStyle(shell), text = getComputedStyle(content)
        const matrix = new DOMMatrix(shape.transform)
        const box = content.getBoundingClientRect()
        samples.push({
          scaleX: matrix.m11, scaleY: matrix.m22, y: matrix.m42, opacity: Number(shape.opacity),
          outerTransform: getComputedStyle(el).transform, textTransform: text.transform, textFilter: text.filter,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
        })
      }
      animation.finish()
      return { samples, duration: timing.duration, iterations: timing.iterations }
    })
    expect(motion.duration).toBe(280)
    expect(motion.iterations).toBe(1)
    for (const [frame, expected] of motion.samples.map((frame, i) => [frame, [
      { scaleX: .94, scaleY: .86, y: 12, opacity: 0 },
      { scaleX: 1.008, scaleY: 1.018, y: -1, opacity: 1 },
      { scaleX: 1, scaleY: 1, y: 0, opacity: 1 },
    ][i]] as const)) {
      expect(frame.scaleX).toBeCloseTo(expected.scaleX, 3)
      expect(frame.scaleY).toBeCloseTo(expected.scaleY, 3)
      expect(frame.y).toBeCloseTo(expected.y, 3)
      expect(frame.opacity).toBeCloseTo(expected.opacity, 3)
      expect(frame.outerTransform).toBe('none')
      expect(frame.textTransform).toBe('none')
      expect(frame.textFilter).toBe('none')
      expect(frame.box).toEqual(motion.samples[0].box)
    }
    await expect(page.locator('.app-modal-backdrop')).toBeVisible()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await trigger.click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await expect(modal.locator('.dialog-motion-surface')).toHaveCSS('transform', 'none')
    await expect(modal.locator('.dialog-motion-content')).toHaveCSS('filter', 'none')
    expect(await modal.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
    const reducedBox = await modal.locator('.dialog-motion-content').boundingBox()
    expect(reducedBox).toEqual(motion.samples.at(-1)!.box)
    await page.getByTestId('folder-name-cancel').click()
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.mouse.click(5, 100)
    await expect(modal).toHaveCount(0)
    await expect(trigger).toBeFocused()
  } finally { await app.close() }
})
