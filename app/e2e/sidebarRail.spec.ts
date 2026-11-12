import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the compact sidebar keeps navigation and folder actions available, including at narrow widths', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-rail-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByTestId('folder-create').click()
    await page.getByTestId('folder-name-input').fill('Standup')
    await page.getByTestId('folder-name-save').click()
    const trashY = (await page.getByTestId('nav-trash').boundingBox())!.y
    const settingsY = (await page.getByTestId('settings-open').boundingBox())!.y
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('nav-chat')).toBeVisible()
    await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).toBe(56)
    await expect(page.locator('.workspace-wordmark')).toHaveCSS('opacity', '1')
    expect((await page.locator('.workspace-wordmark').boundingBox())!.width).toBeGreaterThan(16)
    expect((await page.getByTestId('nav-trash').boundingBox())!.y).toBeCloseTo(trashY, 0)
    expect((await page.getByTestId('settings-open').boundingBox())!.y).toBeCloseTo(settingsY, 0)
    await expect(page.getByTestId('nav-chat')).toHaveAccessibleName('Ask')
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Ask')
    await page.getByTestId('sidebar-folder-open').click({ button: 'right' })
    await expect(page.getByTestId('sidebar-folder-rename')).toBeVisible()
    await expect.poll(async () => (await page.getByTestId('sidebar-folder-menu').boundingBox())!.width).toBeGreaterThanOrEqual(180)
    await page.getByTestId('sidebar-folder-rename').click()
    await expect(page.getByTestId('folder-name-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('sidebar-folder-open')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('folder-title')).toHaveText('Standup')
    await page.getByTestId('search-open').click()
    await expect(page.getByTestId('search-input')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Trash')
    await page.getByTestId('nav-chat').hover()
    const sidebar = page.locator('#workspace-sidebar')
    // Sample an actual transition at its midpoint, independent of runner frame scheduling.
    await sidebar.evaluate(el => el.addEventListener('transitionrun', function pauseWidth(event) {
      if (event.target !== el || (event as TransitionEvent).propertyName !== 'width') return
      for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = 100 }
      el.removeEventListener('transitionrun', pauseWidth)
    }))
    await page.getByTestId('sidebar-expand').click()
    await expect.poll(() => sidebar.evaluate(el => el.getAnimations().some(a => a.playState === 'paused'))).toBe(true)
    const intermediate = (await sidebar.boundingBox())!.width
    expect(intermediate).toBeGreaterThan(56)
    expect(intermediate).toBeLessThan(208)
    await page.getByTestId('sidebar-collapse').click()
    await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).toBe(56)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('sidebar-expand').click()
    await page.getByTestId('sidebar-collapse').click()
    expect(await page.locator('#workspace-sidebar').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 700))
    await page.getByTestId('nav-home').click()
    const rail = await page.locator('#workspace-sidebar').boundingBox()
    const content = await page.locator('.workspace-content').boundingBox()
    expect(content!.x).toBe(rail!.x + rail!.width)
    expect(await page.locator('.workspace').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await page.locator('.workspace-sidebar-body').evaluate(el => getComputedStyle(el).overflowX)).toBe('hidden')
    await page.evaluate(() => { document.documentElement.dir = 'rtl' })
    const logoClip = (await page.locator('.workspace-wordmark').boundingBox())!
    const mark = (await page.getByTestId('wordmark').locator('path').first().boundingBox())!
    expect(mark.x).toBeGreaterThanOrEqual(logoClip.x)
    expect(mark.x + mark.width).toBeLessThanOrEqual(logoClip.x + logoClip.width)

  } finally { await app.close() }
})
