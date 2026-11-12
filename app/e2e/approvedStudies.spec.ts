import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const before = process.env.YOGURT_UI_REVIEW === 'before'
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (onboarding = false) => electron.launch({ args: [main], env: {
  ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-approved-studies-')),
  ...(onboarding ? { YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' } : {}),
} })

test('approved Soft pair reads in Ask and Chat with a static reduced-motion fallback', async ({}, info) => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(4))
    await app.evaluate(({ ipcMain }, id) => {
      const turns = [{ id: 1, question: 'What did we decide?', answer: '', status: 'answering', sources: [] }]
      ipcMain.removeHandler('conversations:get')
      ipcMain.handle('conversations:get', () => ({ id: 'review', title: 'What did we decide?', chips: [], draftChips: [], firstChips: [], draft: '', turns, waitsForMeeting: false, waitsForModel: false }))
    }, id)
    for (const surface of ['ask', 'chat']) {
      await page.evaluate(route => window.yogurt.nav.go(route), surface === 'ask' ? `/note/${id}` : '/chat/review')
      if (surface === 'ask') await page.getByTestId('chat-open').click()
      const container = surface === 'ask' ? page.getByTestId('chat-panel') : page.getByTestId('chat-page')
      await expect(container).toBeVisible()
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
        if (!before) {
          const dots = container.locator('canvas.thinking-dots')
          await expect(dots).toBeVisible()
          const pixels = await dots.evaluate(el => (el as HTMLCanvasElement).toDataURL())
          await expect.poll(() => dots.evaluate(el => (el as HTMLCanvasElement).toDataURL())).not.toBe(pixels)
          await expect(dots).toHaveCSS('width', '18px')
        }
        await container.screenshot({ path: info.outputPath(`loader-${surface}-${before ? 'before' : 'after'}-${colorScheme}.png`) })
      }
      if (!before) {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(container.locator('.thinking-dots-static i')).toHaveCount(3)
        await expect(container.locator('canvas.thinking-dots')).toHaveCount(0)
      }
    }
  } finally { await app.close() }
})

test('approved speaker names keep the stagger and soften focus without moving text', async ({}, info) => {
  const app = await launch(true)
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    for (let i = 0; i < 3; i++) await page.getByTestId('step-later').click()
    await expect(page.getByTestId('speaker-names-art')).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await page.locator('.ob-swap').evaluateAll(els => {
        for (const el of els) for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 2450 }
      })
      if (!before) {
        const names = page.locator('.ob-swap-to')
        expect(await names.nth(0).evaluate(el => getComputedStyle(el).animationDelay)).toBe('0s')
        expect(await names.nth(1).evaluate(el => getComputedStyle(el).animationDelay)).toBe('0.52s')
        const style = await names.first().evaluate(el => ({ filter: getComputedStyle(el).filter, transform: getComputedStyle(el).transform }))
        expect(style.filter).toMatch(/blur\(/)
        expect(style.transform).toBe('none')
      }
      await page.screenshot({ path: info.outputPath(`names-${before ? 'before' : 'after'}-${colorScheme}.png`) })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    if (!before) {
      await expect(page.locator('.ob-swap-to').first()).toHaveCSS('opacity', '1')
      await expect(page.locator('.ob-swap-to').first()).toHaveCSS('filter', 'none')
      expect(await page.locator('.ob-swap').first().evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
    }
  } finally { await app.close() }
})

test('approved welcome conversation and wordmark belong to the introduction', async ({}, info) => {
  const app = await launch(true)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('intro-page')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (!before) {
        await expect(page.locator('.ob-copy .ob-brand')).toBeVisible()
        await expect(page.locator('.ob-conversation .ob-card')).toHaveCount(1)
        await expect(page.locator('.ob-conversation .ob-card-head')).toHaveText('Transcript')
        await expect(page.locator('.ob-conversation .ob-chip')).toHaveText('Saved on this Mac')
        const brand = (await page.locator('.ob-brand').boundingBox())!, title = (await page.getByTestId('step-title').boundingBox())!
        expect(brand.x).toBe(title.x)
        expect(title.y - brand.y - brand.height).toBe(23)
      }
      await page.screenshot({ path: info.outputPath(`welcome-${before ? 'before' : 'after'}-${colorScheme}.png`) })
    }
  } finally { await app.close() }
})

test('approved compact call card shows the Dock icon and pausing countdown in both themes', async ({}, info) => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await app.evaluate(() => (globalThis as any).__fake__.signals({ micApps: [{ bundleId: 'us.zoom.xos', name: 'zoom.us' }], events: [] }))
    await expect.poll(() => app.windows().some(p => p.url().includes('#prompt'))).toBe(true)
    const prompt = app.windows().find(p => p.url().includes('#prompt'))!
    await prompt.emulateMedia({ colorScheme: null })
    await expect(prompt.getByTestId('prompt')).toBeVisible()
    await prompt.getByTestId('prompt').hover()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => window.yogurt.settings.setTheme(theme), theme)
      await expect(prompt.getByTestId('prompt')).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(41, 41, 43)')
      if (!before) {
        expect(await prompt.evaluate(() => [innerWidth, innerHeight])).toEqual([381, 60])
        await expect(prompt.locator('.call-prompt-icon')).toBeVisible()
        const bar = prompt.getByTestId('prompt-countdown')
        await expect(bar).toHaveCSS('animation-play-state', 'paused')
        await bar.evaluate(el => { el.getAnimations()[0].currentTime = 3000 })
        await expect(bar).toHaveCSS('transform', 'matrix(0.75, 0, 0, 1, 0, 0)')
        await expect(prompt.getByTestId('prompt-take-notes')).not.toHaveClass(/primary/)
      }
      await prompt.screenshot({ path: info.outputPath(`call-card-${before ? 'before' : 'after'}-${theme}.png`) })
    }
    if (!before) {
      await prompt.emulateMedia({ reducedMotion: 'reduce' })
      await expect(prompt.getByTestId('prompt-countdown')).toHaveCSS('animation-timing-function', 'steps(12)')
    }
  } finally { await app.close() }
})
