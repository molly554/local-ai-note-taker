import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const before = process.env.YOGURT_UI_REVIEW === 'before'

test('Ask starters hide without moving the landing layout', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-chat-entrance-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await page.getByTestId('nav-chat').click()
      const starters = page.getByTestId('chat-starter')
      await expect(starters).toHaveCount(3)
      if (!before) {
        const title = page.locator('.ask-home-title'), composer = page.getByTestId('chat-page-box')
        const titleBox = await title.boundingBox(), composerBox = await composer.boundingBox()
        expect(await starters.evaluateAll(els => els.every(el => el.getAnimations().length === 0))).toBe(true)
        await page.getByTestId('chat-page-input').fill('What did we decide?')
        await expect(starters).toHaveCount(3)
        await expect(starters.first()).toBeHidden()
        await expect(page.getByTestId('chat-starters')).toHaveAttribute('aria-hidden', 'true')
        expect(await title.boundingBox()).toEqual(titleBox)
        expect(await composer.boundingBox()).toEqual(composerBox)
        await page.getByTestId('chat-page-input').fill('')
        await expect(starters.first()).toBeVisible()
        expect(await title.boundingBox()).toEqual(titleBox)
        await page.getByRole('button', { name: 'Add a meeting or folder', exact: true }).click()
        await expect(starters.first()).toBeHidden()
        expect(await title.boundingBox()).toEqual(titleBox)
        expect(await composer.boundingBox()).toEqual(composerBox)
        await page.getByTestId('chat-page-input').fill('')
        await expect(starters.first()).toBeVisible()
      }
      await page.screenshot({ path: info.outputPath(`chat-${before ? 'before' : 'after'}-${colorScheme}.png`) })
      await page.getByTestId('nav-home').click()
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-starter')).toHaveCount(3)
    expect(await page.getByTestId('chat-starter').evaluateAll(els => els.every(el => el.getAnimations().length === 0 && getComputedStyle(el).opacity === '1' && getComputedStyle(el).transform === 'none'))).toBe(true)
    if (!before) {
      const title = page.locator('.ask-home-title'), titleBox = await title.boundingBox()
      await page.getByTestId('chat-page-input').fill('@')
      await expect(page.getByTestId('chat-starter').first()).toBeHidden()
      await expect(page.getByTestId('chat-starters')).toHaveCSS('transition-duration', '0s')
      expect(await title.boundingBox()).toEqual(titleBox)
    }
  } finally { await app.close() }
})
