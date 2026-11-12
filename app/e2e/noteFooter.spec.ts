import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('recording controls stay in the header and Ask lives in the footer with stable labels and usable targets at minimum size', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-header-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    const header = page.locator('.note-header'), controls = header.getByTestId('note-state')
    await expect(controls).toHaveAccessibleName('Recording')
    await expect(controls.getByTestId('note-pause')).toBeVisible()
    await expect(controls.getByTestId('note-stop')).toBeVisible()
    await expect(controls).toHaveCSS('border-top-width', '1px')
    await expect(controls.getByTestId('note-pause')).toHaveCSS('border-top-width', '0px')
    await expect(controls.getByTestId('note-stop')).toHaveCSS('border-top-width', '0px')
    await expect(header.getByTestId('chat-open')).toHaveCount(0)
    await expect(page.locator('.note-footer').getByTestId('chat-open')).toContainText('⌘J')
    const brand = (await page.locator('.workspace-brand').boundingBox())!
    const footer = (await page.locator('.note-footer-bar').boundingBox())!
    const content = (await page.locator('.workspace-content').boundingBox())!
    expect(Math.abs(footer.y - brand.y)).toBeLessThan(1)
    expect(Math.abs(footer.height - brand.height)).toBeLessThan(1)
    expect(Math.abs(footer.x - content.x)).toBeLessThan(1)
    expect(Math.abs(footer.width - content.width)).toBeLessThan(1)
    await expect.poll(async () => Number(await page.getByTestId('note-wave').getAttribute('data-level')), { timeout: 15_000 }).toBeGreaterThan(0.05)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      const edges = await page.locator('.note-footer-bar').evaluate(el => {
        const bar = el.getBoundingClientRect(), canvas = document.querySelector('.workspace-content')!.getBoundingClientRect()
        const reading = document.querySelector('.note-reading-area')!.getBoundingClientRect()
        return { left: bar.left - canvas.left, right: canvas.right - bar.right, bottom: innerHeight - bar.bottom,
          gap: bar.top - reading.bottom, masked: [el, el.parentElement!].some(node => getComputedStyle(node).maskImage !== 'none') }
      })
      expect(edges).toEqual({ left: 0, right: 0, bottom: 0, gap: 0, masked: false })
      const finishStyle = await page.getByTestId('note-stop').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
      expect(finishStyle.background).not.toBe(await page.getByTestId('note-pause').evaluate(el => getComputedStyle(el).backgroundColor))
      expect(finishStyle.color).not.toBe(finishStyle.background)
      const groupBox = (await controls.boundingBox())!, capBox = (await page.getByTestId('note-stop').boundingBox())!
      expect(capBox.y).toBe(groupBox.y)
      expect(capBox.height).toBe(groupBox.height)
      const rtl = await controls.evaluate(el => getComputedStyle(el).direction === 'rtl')
      expect(rtl ? capBox.x : capBox.x + capBox.width).toBe(rtl ? groupBox.x : groupBox.x + groupBox.width)
      for (const dir of ['ltr', 'rtl']) {
        await page.evaluate((direction) => document.documentElement.dir = direction, dir)
        await page.setViewportSize({ width: 720, height: 520 })
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
        await expect(page.getByTestId('workspace')).toHaveClass(/sidebar-collapsed/)
        const targets = [page.getByTestId('note-pause'), page.getByTestId('note-stop'), page.getByTestId('chat-open'), page.getByTestId('note-transcript-toggle'), page.getByTestId('note-notes-tab')]
        const width = await page.evaluate(() => innerWidth)
        for (const target of targets) {
          await expect(target).toBeInViewport()
          const box = (await target.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
          expect(box.height).toBeGreaterThanOrEqual(28)
        }
        const body = (await page.getByTestId('transcript-panel').boundingBox())!
        expect(body.height).toBeGreaterThan(100)
        const headerBox = (await header.boundingBox())!
        expect(body.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height)
      }
    }
    await page.evaluate(() => document.documentElement.dir = 'ltr')
    // The effective viewport of a720×520 window zoomed to1.6× still exposes every primary action.
    await page.setViewportSize({ width: 450, height: 325 })
    for (const id of ['note-pause', 'note-stop', 'note-transcript-toggle', 'note-notes-tab']) {
      await expect(page.getByTestId(id)).toBeInViewport()
      const box = (await page.getByTestId(id).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(450)
    }
    expect((await page.getByTestId('transcript-panel').boundingBox())!.height).toBeGreaterThan(100)
    await page.getByTestId('transcript-panel').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('transcript-search')).toBeInViewport()
    await page.getByTestId('note-pause').scrollIntoViewIfNeeded()
    const recordingWidth = (await controls.boundingBox())!.width
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await expect(controls).toHaveAccessibleName('Paused')
    expect(Math.abs((await controls.boundingBox())!.width - recordingWidth)).toBeLessThan(1)
    const pausedWave = await page.getByTestId('note-wave').evaluate(el => (el as HTMLCanvasElement).toDataURL())
    await page.waitForTimeout(150)
    expect(await page.getByTestId('note-wave').evaluate(el => (el as HTMLCanvasElement).toDataURL())).toBe(pausedWave)
    await page.getByTestId('note-pause').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('note-stop')).toBeFocused()
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-input')).toBeFocused()
  } finally { await app.close() }
})
