import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const capture = !!process.env.YOGURT_UI_REVIEW
const frames = [0, 60, 120, 200, 280, 400]
const names = (icon: Locator) => icon.evaluate(el => [el, ...Array.from(el.querySelectorAll('*'))]
  .flatMap(node => getComputedStyle(node).animationName.split(', ')).filter(name => name !== 'none'))

for (const theme of ['light', 'dark'] as const) test(`sidebar icon scope and motion in ${theme}`, async ({}, testInfo) => {
  test.setTimeout(180000)
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-icons-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData,
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
    await app.evaluate(async () => {
      const fake = (globalThis as unknown as { __fake__: { bigMeeting(n: number): string; go(route: string): void } }).__fake__
      fake.go(`/note/${fake.bigMeeting(10)}`)
    })
    await expect(page.getByTestId('chat-open')).toBeVisible()
    const saveFrames = async (control: Locator, label: string) => {
      if (!capture) return
      const dir = testInfo.outputPath('icon-review', theme, label)
      mkdirSync(dir, { recursive: true })
      const svg = control.locator('svg').first()
      // Freeze only the icon's own CSS motion, at repeatable times for review frames.
      await svg.evaluate(el => { el.getAnimations({ subtree: true }).forEach(a => { a.pause(); a.currentTime = 0 }) })
      for (const time of frames) {
        await svg.evaluate((el, time) => { el.getAnimations({ subtree: true }).forEach(a => { a.currentTime = time }) }, time)
        await control.screenshot({ path: join(dir, `${time}.png`), animations: 'allow' })
      }
      await svg.evaluate(el => { el.getAnimations({ subtree: true }).forEach(a => a.finish()) })
    }
    const hover = async (id: string, motion: string | null) => {
      const control = page.getByTestId(id), svg = control.locator('svg').first()
      await page.mouse.move(600, 80)
      await expect.poll(() => names(svg)).toEqual([])
      await control.hover()
      await expect.poll(() => names(svg)).toEqual(motion === 'icon-write' ? [motion, motion] : motion ? [motion] : [])
      await saveFrames(control, id)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await expect.poll(() => names(svg)).toEqual([])
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    }
    for (const [id, motion] of [['nav-home', 'icon-write'], ['nav-chat', 'icon-write'], ['settings-open', 'icon-turn']] as const) await hover(id, motion)
    await hover('nav-trash', 'icon-lift')
    await hover('search-open', null)
    await page.evaluate(() => window.yogurt.folders.create('Project'))
    await hover('sidebar-folder-open', null)
    await page.mouse.move(600, 80)
    const search = page.getByTestId('search-open').locator('svg')
    await expect(search).toHaveAttribute('width', '16')
    await expect(search).toHaveAttribute('stroke-width', '1.75')
    if (capture) {
      const svg = await search.evaluate(el => {
        const copy = el.cloneNode(true) as SVGElement
        copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        copy.setAttribute('style', `color:${getComputedStyle(el).color}`)
        return copy.outerHTML
      })
      writeFileSync(testInfo.outputPath('icon-review', theme, 'search.svg'), svg)
    }
    await hover('sidebar-collapse', null)
    await page.getByTestId('sidebar-collapse').click()
    const expand = page.getByTestId('sidebar-expand')
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await saveFrames(expand, 'toggle-collapse')
    await expect(expand.locator('.sidebar-toggle-pane')).toHaveCSS('width', '2px')
    await page.mouse.move(600, 80)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await expand.click()
    const divider = page.getByTestId('sidebar-collapse').locator('.sidebar-toggle-pane')
    await expect(divider).toHaveCSS('transition-duration', '0s')
    await expect(divider).toHaveCSS('width', '6px')
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
    await page.getByTestId('sidebar-collapse').click()
    await page.getByTestId('sidebar-expand').click()
    await saveFrames(page.getByTestId('sidebar-collapse'), 'toggle-expand')
    await page.mouse.move(600, 80)
    await page.keyboard.press('Control+Meta+s')
    await expect(page.getByTestId('sidebar-expand').locator('.sidebar-toggle-pane')).toHaveCSS('transition-duration', '0s')
    await page.keyboard.press('Control+Meta+s')
    await hover('chat-open', null)
    await hover('share-button', null)
    await page.getByTestId('share-button').click()
    for (const id of ['share-copy-notes', 'share-copy-summary', 'share-copy-transcript']) await hover(id, null)
    await page.keyboard.press('Escape')
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-copy-answer')).toBeVisible({ timeout: 20000 })
    await hover('chat-copy-answer', null)
  } finally { await app.close() }
})
