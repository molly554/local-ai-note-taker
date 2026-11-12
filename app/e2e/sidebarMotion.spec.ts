import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-sidebar-')) } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  return { app, page }
}

test('Ask opens in the note panel, and Command-J starts a conversation elsewhere', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByTestId('assistant-open')).toHaveCount(0)
    // away from a note, ⌘J opens Chat across all meetings
    await page.keyboard.press('Meta+j')
    await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toMatch(/^\/chat\/[^/]+$/)
    await page.evaluate(() => window.yogurt.nav.go(''))
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await page.getByTestId('past-note').click()
    await expect(page.getByTestId('chat-open')).toBeVisible()
    await expect(page.getByTestId('chat-input')).toHaveCount(0)
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('chat-input')).toBeFocused()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-input')).toBeVisible()
    await page.keyboard.press('Meta+j')
    await expect(page.getByTestId('search-input')).toBeFocused()
  } finally { await app.close() }
})

test('sidebar reveal keeps its toggle anchored and can reverse before it finishes', async () => {
  const { app, page } = await launch()
  try {
    const toggle = page.locator('.workspace-sidebar-toggle')
    const content = page.locator('.workspace-content')
    const gap = page.locator('.workspace-sidebar-gap')
    const before = await toggle.boundingBox()
    // Establish the initial style, then hold a long transition so CI cannot miss its first frame.
    const motionStyle = await page.addStyleTag({ content: '.workspace-sidebar-gap { transition-duration:60s!important; }' })
    await gap.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect((await toggle.boundingBox())!.x).toBe(before!.x)
    await expect.poll(() => gap.evaluate((el) => {
      const animation = el.getAnimations().find(a => a instanceof CSSTransition && a.transitionProperty === 'width')
      if (!animation) return false
      animation.pause(); animation.currentTime = 18_000
      return true
    })).toBe(true)
    const midway = await gap.evaluate(el => el.getBoundingClientRect().width)
    expect(midway).toBeGreaterThan(56)
    expect(midway).toBeLessThan(208)
    await motionStyle.evaluate(el => { el.parentNode?.removeChild(el) })
    await page.mouse.click(before!.x + before!.width / 2, before!.y + before!.height / 2)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => gap.evaluate((el) => el.getBoundingClientRect().width)).toBe(208)
    await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeVisible()
    expect((await content.boundingBox())!.x).toBe(208)
    expect(await toggle.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  } finally { await app.close() }
})

test('native titlebar drag regions leave the sidebar and toolbar controls clickable', async () => {
  const { app, page } = await launch()
  try {
    for (const width of [1100, 720]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(width, 760), width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      if (width < 900) await expect(page.locator('.workspace-sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
      for (const direction of ['ltr', 'rtl']) {
        await page.evaluate((direction) => { document.documentElement.dir = direction }, direction)
        for (let toggle = 0; toggle < 2; toggle++) {
          await page.locator('.workspace-sidebar-toggle').click()
          for (const time of [0, 120, 240]) {
            const blocked = await page.evaluate((time) => {
              for (const animation of document.querySelector('.workspace')!.getAnimations({ subtree: true })) {
                animation.pause(); animation.currentTime = time
              }
              // Electron combines draggable rectangles in document order, independent of CSS z-index.
              const regions = Array.from(document.querySelectorAll('.workspace *')).flatMap((el) => {
                const style = getComputedStyle(el), kind = style.getPropertyValue('-webkit-app-region')
                return kind !== 'none' && style.visibility === 'visible' ? [{ kind, bounds: el.getBoundingClientRect() }] : []
              })
              return Array.from(document.querySelectorAll('.workspace-sidebar-toggle, .workspace-toolbar button, .home-toolbar-action button')).flatMap((el) => {
                const bounds = el.getBoundingClientRect()
                if (!bounds.width || !bounds.height) return []
                const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
                const region = regions.filter(({ bounds }) => x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom).at(-1)
                return region?.kind === 'drag' ? [el.getAttribute('aria-label') ?? el.textContent] : []
              })
            }, time)
            expect(blocked, `${width}px ${direction} at ${time}ms`).toEqual([])
          }
          await page.locator('.workspace').evaluate((el) => { for (const animation of el.getAnimations({ subtree: true })) if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })
        }
      }
    }
  } finally { await app.close() }
})

test('titlebar chrome stays continuous throughout either sidebar direction', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    const divider = await page.locator('.workspace-sidebar').evaluate(el => ({ border: getComputedStyle(el).borderInlineEndColor, start: getComputedStyle(el, '::after').top }))
    expect(divider).toEqual({ border: 'rgba(0, 0, 0, 0)', start: '52px' })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const direction of ['ltr', 'rtl']) {
        await page.evaluate((direction) => { document.documentElement.dir = direction }, direction)
        for (let toggle = 0; toggle < 2; toggle++) {
          await page.locator('.workspace-sidebar-toggle').click()
          for (const time of [0, 60, 120, 180, 239]) {
            const chrome = await page.evaluate((time) => {
              const workspace = document.querySelector('.workspace')!
              for (const animation of workspace.getAnimations({ subtree: true })) {
                animation.pause(); animation.currentTime = time
              }
              const pieces = ['.workspace-window-bar', '.workspace-toolbar', '.workspace-sidebar'].flatMap((selector) => {
                const el = document.querySelector(selector)!, style = getComputedStyle(el)
                if (style.visibility !== 'visible') return []
                const bounds = el.getBoundingClientRect()
                return [{ left: bounds.left, right: bounds.right, color: style.backgroundColor }]
              }).sort((a, b) => a.left - b.left)
              return { pieces, width: innerWidth }
            }, time)
            let edge = 0
            for (const piece of chrome.pieces) {
              expect(piece.left, `${colorScheme}/${direction} gap at ${time}ms: ${JSON.stringify(chrome)}`).toBeLessThanOrEqual(edge + 0.5)
              expect(piece.color).toBe(chrome.pieces[0].color)
              edge = Math.max(edge, piece.right)
            }
            expect(edge).toBeGreaterThanOrEqual(chrome.width - 0.5)
            if (direction === 'ltr' && time === 120) {
              const name = `${colorScheme}-${toggle === 0 ? 'collapse' : 'expand'}`
              const path = testInfo.outputPath(`${name}.png`)
              await page.screenshot({ path })
              await testInfo.attach(name, { path, contentType: 'image/png' })
            }
          }
          await page.locator('.workspace').evaluate((el) => {
            for (const animation of el.getAnimations({ subtree: true })) animation.finish()
          })
        }
      }
    }
  } finally { await app.close() }
})

test('keyboard, reduced motion and narrow-window sidebar changes remain immediate and accessible', async () => {
  const { app, page } = await launch()
  try {
    const toggle = page.locator('.workspace-sidebar-toggle')
    const gap = page.locator('.workspace-sidebar-gap')
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(await gap.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'))).toBe(false)
    expect((await gap.boundingBox())!.width).toBe(56)
    await expect(page.getByTestId('nav-home')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('search-open')).toBeFocused()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await toggle.click()
    expect(await gap.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'))).toBe(false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 600))
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => { document.documentElement.dir = 'rtl' })
    const rtlX = (await toggle.boundingBox())!.x
    const start = (await page.locator('.home-toolbar-action').boundingBox())!
    expect(start.x).toBeGreaterThan(rtlX + (await toggle.boundingBox())!.width)
    await toggle.click()
    expect((await toggle.boundingBox())!.x).toBe(rtlX)
    await toggle.click()
    await page.getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
  } finally { await app.close() }
})

test('a note keeps its title, transcript and controls in place at the start of both sidebar directions', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-title').getByRole('button').click()
    await page.getByTestId('note-title-input').fill('A long meeting title about launch planning, customer feedback and the next set of product improvements')
    await page.getByTestId('note-title-input').press('Enter')
    await page.getByTestId('note-transcript-toggle').click()
    await page.getByTestId('transcript-panel').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
    const selectors = ['[data-testid="note-title"]', '[data-testid="note-topbar"]', '[data-testid="chat-open"]', '[data-testid="transcript-panel"]']
    const boxes = () => page.evaluate((selectors) => selectors.map((s) => {
      const b = document.querySelector(s)!.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    }), selectors)
    const icon = await page.locator('.workspace-sidebar-toggle svg').innerHTML()
    for (const width of [1100, 920, 720]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(width, 760), width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      if (width < 900) await expect(page.locator('.workspace-sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
      for (let direction = 0; direction < 2; direction++) {
        const before = await boxes()
        await page.locator('.workspace-sidebar-toggle').click()
        await page.locator('.workspace').evaluate((el) => {
          for (const animation of el.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 0 }
        })
        const start = await boxes()
        for (let i = 0; i < start.length; i++) for (const key of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(start[i][key] - before[i][key]), `${selectors[i]} ${key}, window ${width}`).toBeLessThan(1)
        }
        expect(await page.locator('.workspace-sidebar-toggle svg').innerHTML()).toBe(icon)
        expect(await page.locator('.workspace-sidebar-toggle .sidebar-toggle-pane').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
        await page.locator('.workspace').evaluate((el) => { for (const animation of el.getAnimations({ subtree: true })) if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
    }
  } finally { await app.close() }
})
