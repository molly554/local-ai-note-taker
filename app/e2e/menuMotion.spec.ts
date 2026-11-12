import { _electron as electron, expect, test, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const menus = [
  { trigger: 'share-button', surface: 'share-menu', first: 'share-copy-notes', logical: false },
  { trigger: 'note-menu-button', surface: 'note-menu', first: 'note-rename', logical: false },
  { trigger: 'note-view-menu', surface: 'note-view-menu-list', first: 'note-write-again', logical: true, end: true },
  { trigger: 'note-date', surface: 'note-date-card', first: 'note-date-heading', logical: true },
  { trigger: 'note-attendees', surface: 'people-card', first: 'people-add', logical: true },
]

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-menu-motion-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
  await page.reload()
  await page.getByTestId('past-note').click()
  await expect(page.getByTestId('note-enhanced')).toBeVisible()
  return { app, page }
}

const motion = (surface: Locator) => surface.evaluate((el) => {
  const style = getComputedStyle(el), origin = style.transformOrigin.split(' ').map(parseFloat)
  return { animation: style.animationName, x: origin[0], y: origin[1], width: (el as HTMLElement).offsetWidth }
})

test('keyboard menus open without animation, focus immediately and dismiss back to their triggers', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const key of ['Enter', 'Space']) for (const menu of menus) {
      const trigger = page.getByTestId(menu.trigger), surface = page.getByTestId(menu.surface)
      await trigger.focus()
      await page.keyboard.press(key)
      await expect(surface).toBeVisible()
      expect((await motion(surface)).animation).toBe('none')
      await expect(page.getByTestId(menu.first)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(surface).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
  } finally { await app.close() }
})

test('pointer menus share anchored entry in LTR and RTL; reduced motion removes it without delaying focus', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const dir of ['ltr', 'rtl']) {
      await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
      for (const menu of menus) {
        const surface = page.getByTestId(menu.surface)
        await page.getByTestId(menu.trigger).click()
        await expect(surface).toBeVisible()
        const actual = await motion(surface)
        expect(actual.animation).not.toBe('none')
        expect(actual.y).toBe(0)
        const left = menu.logical && (menu.end ? dir === 'rtl' : dir === 'ltr')
        expect(actual.x).toBeCloseTo(left ? 0 : actual.width, 1)
        await expect(page.getByTestId(menu.first)).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(surface).toHaveCount(0)
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const menu of menus) {
      const surface = page.getByTestId(menu.surface)
      await page.getByTestId(menu.trigger).click()
      await expect(surface).toBeVisible()
      expect((await motion(surface)).animation).toBe('none')
      await expect(page.getByTestId(menu.first)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(surface).toHaveCount(0)
    }
  } finally { await app.close() }
})
