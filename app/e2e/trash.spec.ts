import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-trash-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
/** four finished meetings, newest first: Budget review, Weekly sync, Customer call with Acme, Design crit */
async function withMeetings(app: ElectronApplication, page: Page) {
  await fake(app, 'manyMeetings', { n: 4, clean: true })
  await page.reload()
  await expect(page.getByTestId('past-note')).toHaveCount(4)
}
const row = (page: Page, title: string) => page.locator('.native-meeting-row').filter({ hasText: title })
const del = async (page: Page, title: string) => {
  await row(page, title).hover()
  await row(page, title).getByTestId('past-note-more').click()
  await page.getByTestId('past-note-trash').click()
  // The previous toast can still be visible while the asynchronous list refresh is pending.
  await expect(row(page, title)).toHaveCount(0)
  await expect(page.getByTestId('trash-toast')).toContainText('Moved to the Trash')
}

test('meeting rows swap metadata for More without shifting content and share pointer and keyboard actions', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    const card = row(page, 'Budget review'), link = card.getByTestId('past-note'), more = card.getByTestId('past-note-more')
    await page.mouse.move(0, 0)
    await expect(more).toHaveCSS('opacity', '0')
    const meta = card.locator('.meeting-meta')
    await expect(meta).toHaveCSS('opacity', '1')
    const before = await link.boundingBox()
    const metaBefore = await meta.boundingBox()
    const rowBox = await card.boundingBox()
    expect(rowBox!.x + rowBox!.width - metaBefore!.x - metaBefore!.width).toBeCloseTo(8)
    await card.hover()
    await expect(more).toHaveCSS('opacity', '1')
    await expect(more).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(meta).toHaveCSS('opacity', '0')
    expect((await meta.boundingBox())!.width).toEqual(metaBefore!.width)
    expect(await link.boundingBox()).toEqual(before)
    await more.hover()
    expect(await more.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await more.evaluate(el => {
      const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--control-hover)'; el.append(probe)
      const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color
    }))
    await page.mouse.move(0, 0)
    await link.focus()
    await page.keyboard.press('Tab')
    await expect(more).toBeFocused()
    await page.keyboard.press('Space')
    const menu = page.getByTestId('meeting-row-menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Add to folder', 'Move to Trash'])
    await expect(menu.getByRole('menuitem', { name: 'Add to folder' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Move to Trash' })).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('meeting-row-folders')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(link).toBeFocused()
    await card.click({ button: 'right', position: { x: 40, y: 20 } })
    await expect(menu.getByRole('menuitem')).toHaveText(['Add to folder', 'Move to Trash'])
    await page.keyboard.press('Escape')
    await expect(link).toBeFocused()
    await page.keyboard.press('Backspace')
    await expect(page.getByTestId('past-note')).toHaveCount(4)
    await page.keyboard.press('Delete')
    await expect(page.getByTestId('past-note')).toHaveCount(3)
    await page.getByTestId('trash-undo').click()
    await expect(page.getByTestId('past-note')).toHaveCount(4)
  } finally { await app.close() }
})

test('toasts follow appearance; the latest deletion can be undone from the keyboard', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await del(page, 'Weekly sync')
      const toast = page.getByTestId('trash-toast')
      const shade = await toast.evaluate(el => {
        const style = getComputedStyle(el)
        return { background: Number(style.backgroundColor.match(/\d+/)![0]), text: Number(style.color.match(/\d+/)![0]) }
      })
      if (theme === 'dark') { expect(shade.background).toBeLessThan(80); expect(shade.text).toBeGreaterThan(180) }
      else { expect(shade.background).toBeGreaterThan(220); expect(shade.text).toBeLessThan(80) }
      await page.getByTestId('trash-undo').focus()
      await page.keyboard.press('Enter')
      await expect(toast).toHaveCount(0)
      await expect(page.getByTestId('past-note')).toHaveCount(4)
    }
    await del(page, 'Weekly sync')
    await del(page, 'Design crit')
    await expect(page.getByTestId('trash-toast')).toHaveCount(1)
    await page.getByTestId('trash-toast').getByTestId('trash-undo').click()
    await expect(page.getByTestId('past-note').filter({ hasText: 'Design crit' })).toHaveCount(1)
    await expect(page.getByTestId('past-note').filter({ hasText: 'Weekly sync' })).toHaveCount(0)
  } finally { await app.close() }
})

test('the toast countdown pauses on hover and focus, then dismisses when time runs out', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    // The local test window stays hidden; simulate foreground focus without stealing the desktop.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
      window.dispatchEvent(new Event('focus'))
    })
    await del(page, 'Weekly sync')
    const toast = page.getByTestId('trash-toast')
    // no countdown bar; its 6 s timer holds while hovered or focused
    await expect(toast).toBeVisible()
    await expect(toast.locator('[data-animate-ui-toast-progress-bar]')).toHaveCount(0)
    await toast.hover()
    await page.waitForTimeout(6500)
    await expect(toast).toBeVisible()
    await page.keyboard.press('F6')
    await page.getByTestId('trash-undo').focus()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(6500)
    await expect(toast).toBeVisible()
    await page.getByTestId('search-open').focus()
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('trash-row')).toContainText('Weekly sync')
    const trashRow = page.getByTestId('trash-row')
    await page.mouse.move(0, 0)
    await expect(trashRow.locator('.trash-actions')).toHaveCSS('opacity', '0')
    await expect(trashRow.locator('.meeting-meta time')).toHaveText(/\d+:\d+/)
    await expect(trashRow.locator('.meeting-meta')).toHaveCSS('opacity', '1')
    // Programmatic focus after a mouse click stays in pointer mode; only keyboard focus reveals actions.
    await trashRow.focus()
    await expect(trashRow.locator('.trash-actions')).toHaveCSS('opacity', '0')
    await page.keyboard.press('Tab')
    await trashRow.focus()
    await expect(trashRow.locator('.trash-actions')).toHaveCSS('opacity', '1')
    await expect(trashRow.locator('.meeting-meta')).toHaveCSS('opacity', '0')
    await trashRow.getByTestId('trash-restore').focus()
    await expect(trashRow.getByTestId('trash-restore')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(trashRow.getByTestId('trash-delete')).toBeFocused()
    await expect(trashRow.getByTestId('trash-restore')).toHaveAttribute('title', 'Restore')
    await expect(trashRow.getByTestId('trash-delete')).toHaveAttribute('title', 'Delete now')

  } finally { await app.close() }
})

test('the Trash: deleted meetings wait there, out of Meetings, folders and search; restore puts one back in its folder', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await expect(page.getByText('Planned', { exact: true })).toHaveCount(0)
    // a folder holding Weekly sync
    await page.getByTestId('folder-create').click()
    await page.keyboard.type('Team')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('folder-title')).toHaveText('Team')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).dragTo(page.getByTestId('sidebar-folder').filter({ hasText: 'Team' }).getByTestId('sidebar-folder-open'))
    const count = page.getByTestId('sidebar-folder').filter({ hasText: 'Team' }).getByTestId('sidebar-folder-count')
    await expect(count).toHaveText('1')

    await del(page, 'Weekly sync')
    await del(page, 'Design crit')
    await expect(page.getByTestId('past-note')).toHaveCount(2)
    await expect(count).toHaveText('0')
    expect((await page.evaluate(() => window.yogurt.search.query('Weekly'))).map((h) => h.title)).toEqual([])

    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Trash')
    await expect(page.getByTestId('trash-page')).toContainText('deleted for good after 30 days')
    // the last deleted first
    await expect(page.getByTestId('trash-row')).toHaveText([/Design crit/, /Weekly sync/])

    // a trashed note can be opened and read; it says where it is and can be restored from there
    await page.getByTestId('trash-row').filter({ hasText: 'Design crit' }).getByTestId('past-note').click()
    await expect(page.getByTestId('note-trashed')).toContainText('This note is in the Trash.')
    await expect(page.getByTestId('note-resume')).toHaveCount(0)
    await page.getByTestId('note-restore').click()
    await expect(page.getByTestId('note-trashed')).toHaveCount(0)
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('trash-row')).toHaveText([/Weekly sync/])

    await page.getByTestId('trash-row').hover()
    await page.getByTestId('trash-row').getByTestId('trash-restore').click()
    await expect(page.getByTestId('trash-none')).toContainText('The Trash is empty')
    await expect(page.getByTestId('trash-empty')).toHaveCount(0)
    await expect(count).toHaveText('1')
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('past-note')).toHaveCount(4)
    expect((await page.evaluate(() => window.yogurt.search.query('Weekly'))).map((h) => h.title)).toEqual(['Weekly sync'])
  } finally { await app.close() }
})

test('Empty Trash asks first, then deletes every meeting in it for good, recordings too', async () => {
  const { app, page, userData } = await launch()
  try {
    await withMeetings(app, page)
    const ids = await page.evaluate(async () => (await window.yogurt.meetings.cards({ limit: 2 })).map((c) => c.id))
    for (const id of ids) expect(await page.evaluate((id) => window.yogurt.meetings.trash(id), id)).toBe('trashed')
    await page.getByTestId('nav-trash').click()
    await expect(page.getByTestId('trash-row')).toHaveCount(2)
    await page.getByTestId('trash-empty').click()
    const confirm = page.getByTestId('trash-empty-confirm')
    await expect(confirm).toContainText('2 meetings, with their notes, transcripts and recordings, are removed from this Mac for good.')
    await expect(page.getByTestId('trash-empty-cancel')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId('trash-row')).toHaveCount(2)
    await page.getByTestId('trash-empty').click()
    await page.getByTestId('trash-empty-yes').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId('trash-none')).toBeVisible()
    for (const id of ids) {
      expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toBeUndefined()
      expect(existsSync(join(userData, 'meetings', id))).toBe(false)
    }
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('past-note')).toHaveCount(2)
  } finally { await app.close() }
})
