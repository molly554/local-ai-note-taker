import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const before = process.env.YOGURT_UI_REVIEW === 'before'
for (const theme of ['light', 'dark'] as const) for (const width of [1200, 720]) {
  test(`quiet empty states below their headers at ${width} in ${theme}`, async ({}, info) => {
    const userData = mkdtempSync(join(tmpdir(), 'yogurt-empty-'))
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData,
    } })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      const win = await app.browserWindow(page)
      await win.evaluate((w, width) => w.setContentSize(width, 800), width)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      const check = async (id: string, label: string) => {
        const empty = page.getByTestId(id)
        await expect(empty).toBeVisible()
        if (!before) {
          const geometry = await empty.evaluate(el => {
            const outer = el.getBoundingClientRect(), content = el.querySelector('.empty-state-content')!.getBoundingClientRect()
            const tile = el.querySelector('.empty-tile')!.getBoundingClientRect()
            const header = el.previousElementSibling?.getBoundingClientRect()
            return { x: content.x + content.width / 2 - outer.x - outer.width / 2,
              y: content.y + content.height / 2 - outer.y - outer.height / 2,
              above: header ? outer.top - header.bottom : 0, tile: [tile.width, tile.height],
              overflow: el.scrollWidth - el.clientWidth }
          })
          expect(Math.abs(geometry.x)).toBeLessThan(1)
          expect(geometry.y).toBeCloseTo(-12, 0)
          expect(geometry.above).toBeGreaterThanOrEqual(-1)
          expect(geometry.tile).toEqual([64, 64])
          expect(geometry.overflow).toBe(0)
          const motion = await empty.evaluate(el => [el, ...Array.from(el.querySelectorAll('*'))].flatMap(node => getComputedStyle(node).animationName.split(', ')).filter(n => n !== 'none'))
          expect(motion).toEqual([])
        }
        await page.screenshot({ path: info.outputPath(`empty-${label}-${theme}-${width}.png`) })
      }
      await check('past-empty', 'meetings')
      await page.getByTestId('nav-trash').click()
      await check('trash-none', 'trash')
      await page.getByTestId('folder-create').click()
      await page.getByTestId('folder-name-input').fill('Projects')
      await page.keyboard.press('Enter')
      await check('folder-empty', 'folder')
      await page.getByTestId('nav-chat').click()
      await expect(page.getByTestId('chat-page-box')).toBeVisible()
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' })
      await expect(page.getByTestId('chat-starter')).toHaveCount(3)
      await expect(page.getByTestId('chat-starter').first()).toHaveCSS('animation-name', 'none')
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      // Prepared calendar notes have no transcript or recording timer to race the capture.
      await page.evaluate(async () => {
        const day = Date.now(), event = (await window.yogurt.calendar.day(day)).events[0]
        if (!event) throw new Error('Missing fake calendar event')
        const result = await window.yogurt.meetings.prepare(event.id, day)
        if (!('id' in result)) throw new Error(result.error)
      })
      await page.getByTestId('note-transcript-toggle').click()
      await check('transcript-empty', 'transcript')
    } finally { await app.close() }
  })
}
