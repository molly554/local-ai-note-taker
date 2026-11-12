import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
/** four finished meetings, newest first: Budget review, Weekly sync, Customer call with Acme, Design crit */
async function withMeetings(app: ElectronApplication, page: Page) {
  await fake(app, 'manyMeetings', { n: 4, clean: true })
  await page.reload()
  await expect(page.getByTestId('past-note')).toHaveCount(4)
}
const folder = (page: Page, name: string) => page.getByTestId('sidebar-folder').filter({ hasText: name })
async function newFolder(page: Page, name: string) {
  await page.getByTestId('folder-create').click()
  await expect(page.getByTestId('folder-name-input')).toBeFocused()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('folder-title')).toHaveText(name)
}
const openNote = async (page: Page, title: string) => {
  await page.getByTestId('nav-home').click()
  await page.getByTestId('past-note').filter({ hasText: title }).click()
  await expect(page.getByTestId('note-title')).toHaveText(title)
}

test('folder icons stay still and Trash animates once on hover in either sidebar size and respect reduced motion', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await newFolder(page, 'Standup')
    for (const compact of [false, true]) {
      if (compact) await page.getByTestId('sidebar-collapse').click()
      for (const row of [page.getByTestId('sidebar-folder-open'), page.getByTestId('nav-trash')]) {
        await page.mouse.move(700, 300)
        const svg = row.locator('svg').first()
        await expect(svg).toHaveCSS('animation-name', 'none')
        await row.hover()
        await expect(svg).toHaveCSS('animation-name', await row.getAttribute('data-testid') === 'nav-trash' ? 'icon-lift' : 'none')
        await expect(svg).toHaveCSS('animation-iteration-count', '1')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect(svg).toHaveCSS('animation-name', 'none')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
      }
    }
  } finally { await app.close() }
})

test('folders reorder within their section, persist, and remain keyboard accessible', async () => {
  const { app, page } = await launch()
  try {
    for (const name of ['Alpha', 'Bravo', 'Charlie']) await newFolder(page, name)
    await page.getByTestId('nav-home').click()
    const group = page.getByTestId('folder-reorder-list')
    const bounds = await group.boundingBox()
    const start = await folder(page, 'Charlie').getByTestId('sidebar-folder-open').boundingBox()
    expect(bounds).toBeTruthy(); expect(start).toBeTruthy()
    await page.mouse.move(start!.x + 70, start!.y + start!.height / 2)
    await page.mouse.down()
    await page.mouse.move(start!.x + 70, bounds!.y - 200, { steps: 20 })
    await expect.poll(async () => (await folder(page, 'Charlie').boundingBox())!.y).toBeGreaterThanOrEqual(bounds!.y - 1)
    await page.mouse.up()
    const labels = page.getByTestId('sidebar-folder-open')
    await expect(labels).toHaveText([/Charlie/, /Alpha/, /Bravo/])
    await expect(page.getByTestId('home')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.yogurt.folders.list()).map(f => f.name))).toEqual(['Charlie', 'Alpha', 'Bravo'])
    await page.reload()
    await expect(labels).toHaveText([/Charlie/, /Alpha/, /Bravo/])
    await folder(page, 'Charlie').getByTestId('sidebar-folder-open').focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(labels).toHaveText([/Alpha/, /Charlie/, /Bravo/])
    await folder(page, 'Charlie').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-title')).toHaveText('Charlie')
  } finally { await app.close() }
})

test('a folder is made in the sidebar, opens empty, and is renamed in place and from its menu', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.getByText('Folders and folders are being built.')).toHaveCount(0)
    await newFolder(page, 'Acme')
    await expect(page.getByTestId('folder-empty')).toBeVisible()
    await expect(page.getByTestId('workspace-heading')).toHaveText('Acme')
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-open')).toHaveAttribute('aria-current', 'page')

    await page.getByTestId('folder-title').getByRole('button').click()
    await page.getByTestId('folder-title-input').fill('Acme Inc')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('folder-title')).toHaveText('Acme Inc')
    await expect(folder(page, 'Acme Inc')).toBeVisible()

    await folder(page, 'Acme Inc').hover()
    await folder(page, 'Acme Inc').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-rename').click()
    await page.getByTestId('folder-name-input').fill('Customers')
    await page.getByTestId('folder-name-save').click()
    await expect(page.getByTestId('folder-title')).toHaveText('Customers')
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(1)
    // Escape keeps the name
    await page.getByTestId('folder-title').getByRole('button').click()
    await page.getByTestId('folder-title-input').fill('Nope')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('folder-title')).toHaveText('Customers')
  } finally { await app.close() }
})

test('a note goes into folders from its menu and its chip, and a new folder from the menu takes it at once', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await openNote(page, 'Weekly sync')
    await page.getByTestId('folder-suggestion-cancel').click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Add to folder')

    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-add-to-folder').click()
    const option = page.getByTestId('note-menu-folders').getByTestId('folder-option').filter({ hasText: 'Acme' })
    await expect(option).toHaveAttribute('aria-checked', 'false')
    await option.click()
    await expect(option).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Acme')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('note-menu')).toHaveCount(0)

    // New folder… names one and puts this note in it
    await page.getByTestId('note-menu-button').click()
    await page.getByTestId('note-add-to-folder').click()
    await page.getByTestId('note-menu-folders').getByTestId('folder-new').click()
    await page.getByTestId('folder-name-input').fill('Board')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Acme + 1')
    await expect(folder(page, 'Board').getByTestId('sidebar-folder-count')).toHaveText('1')

    // the chip: same list; taking it out of Acme
    await page.getByTestId('note-folders').click()
    const list = page.getByTestId('folder-chip-list')
    await expect(list.getByTestId('folder-option').filter({ hasText: 'Board' })).toHaveAttribute('aria-checked', 'true')
    await list.getByTestId('folder-option').filter({ hasText: 'Acme' }).click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Board')
    await page.keyboard.press('Escape')

    // Dismiss this note's independent suggestion before testing manual filing.
    await openNote(page, 'Budget review')
    await page.getByTestId('folder-suggestion-cancel').click()
    await page.getByTestId('note-folders').click()
    await page.getByTestId('folder-chip-list').getByTestId('folder-option').filter({ hasText: 'Board' }).click()
    await expect(page.getByTestId('note-folders-summary')).toHaveText('Board')

    // the folder's page: its meetings, newest first, as on Meetings
    await folder(page, 'Board').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Budget review/, /Weekly sync/])
    await page.getByTestId('folder-page').getByTestId('past-note').first().click()
    await expect(page.getByTestId('note-title')).toHaveText('Budget review')
  } finally { await app.close() }
})

test('a meeting row dragged onto a folder goes into it; ⌘K on a folder page looks only there', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    await page.getByTestId('nav-home').click()
    const preview = page.evaluate(() => new Promise<{ width: number; height: number; text: string | null; icon: boolean }>((resolve) => {
      const original = DataTransfer.prototype.setDragImage
      DataTransfer.prototype.setDragImage = function (element, x, y) {
        const { width, height } = element.getBoundingClientRect()
        resolve({ width, height, text: element.textContent, icon: !!element.querySelector('.meeting-identity') })
        DataTransfer.prototype.setDragImage = original
        original.call(this, element, x, y)
      }
    }))
    await page.getByTestId('past-note').filter({ hasText: 'Customer call with Acme' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    const dragged = await preview
    expect(dragged).toMatchObject({ text: 'Customer call with Acme', icon: true })
    expect(dragged.width).toBeLessThanOrEqual(280)
    expect(dragged.height).toBeLessThanOrEqual(54)
    await expect(page.locator('.meeting-drag-preview')).toHaveCount(0)
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')
    await page.getByTestId('past-note').filter({ hasText: 'Design crit' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('2')
    // dropping it twice changes nothing
    await page.getByTestId('past-note').filter({ hasText: 'Design crit' }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    await folder(page, 'Acme').getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Customer call with Acme/, /Design crit/])

    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-scope')).toHaveText('Acme')
    await expect(page.getByTestId('search-result')).toHaveCount(2)
    await page.keyboard.type('budget')
    await expect(page.getByTestId('search-none')).toBeVisible()
    await page.getByTestId('search-scope-clear').click()
    await expect(page.getByTestId('search-result').first()).toContainText('Budget review')
    await expect(page.getByTestId('search-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    // from anywhere else, search looks everywhere
    await page.getByTestId('nav-home').click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByTestId('search-scope')).toHaveCount(0)
    await expect(page.getByTestId('search-result')).toHaveCount(4)
  } finally { await app.close() }
})

test('deleting a folder asks first and keeps its meetings; deleting a meeting takes it out of its folders', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await newFolder(page, 'Acme')
    for (const title of ['Weekly sync', 'Design crit']) {
      await page.getByTestId('nav-home').click()
      await page.getByTestId('past-note').filter({ hasText: title }).dragTo(folder(page, 'Acme').getByTestId('sidebar-folder-open'))
    }
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('2')

    // a meeting deleted from the folder's page (to the Trash) leaves the folder too
    await folder(page, 'Acme').getByTestId('sidebar-folder-open').click()
    const row = page.getByTestId('folder-page').getByRole('listitem').filter({ hasText: 'Design crit' })
    await row.hover()
    await row.getByTestId('past-note-more').click()
    await page.getByTestId('past-note-trash').click()
    await expect(page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Weekly sync/])
    await expect(folder(page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')

    await folder(page, 'Acme').hover()
    await folder(page, 'Acme').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-delete').click()
    const confirm = page.getByTestId('folder-delete-confirm')
    await expect(confirm).toContainText('Its meetings stay in Meetings.')
    await expect(page.getByTestId('folder-delete-cancel')).toBeFocused()
    await page.getByTestId('folder-delete-cancel').click()
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(1)

    await folder(page, 'Acme').hover()
    await folder(page, 'Acme').getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-delete').click()
    await page.getByTestId('folder-delete-yes').click()
    await expect(page.getByTestId('sidebar-folder')).toHaveCount(0)
    // it was open: back to Meetings, where every meeting still is
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('past-note')).toHaveCount(3)
  } finally { await app.close() }
})

test('a backup carries folders and which meetings are in them', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-backup-')), 'Lynote NoteTaker backup.zip')
  const a = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await withMeetings(a.app, a.page)
    await newFolder(a.page, 'Acme')
    await a.page.getByTestId('nav-home').click()
    await a.page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).dragTo(folder(a.page, 'Acme').getByTestId('sidebar-folder-open'))
    await expect(folder(a.page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')
    await newFolder(a.page, 'Zulu')
    await a.page.evaluate(async () => { const folders = await window.yogurt.folders.list(); await window.yogurt.folders.reorder(folders.map(f => f.id).reverse()) })
    await a.page.getByTestId('settings-open').click()
    await a.page.getByTestId('backup-export').click()
    await expect(a.page.getByTestId('backup-said')).toContainText('Exported 4 meetings')
  } finally { await a.app.close() }

  const b = await launch({ YOGURT_BACKUP_PATH: file })
  try {
    await expect(b.page.getByTestId('sidebar-folder')).toHaveCount(0)
    await b.page.getByTestId('settings-open').click()
    await b.page.getByTestId('backup-import').click()
    await expect(b.page.getByTestId('backup-said')).toHaveText('Added 4 meetings.')
    await expect(b.page.getByTestId('sidebar-folder-open')).toHaveText([/Zulu/, /Acme/])
    // the sidebar heard about it without a reload
    await expect(folder(b.page, 'Acme').getByTestId('sidebar-folder-count')).toHaveText('1')
    await folder(b.page, 'Acme').getByTestId('sidebar-folder-open').click()
    await expect(b.page.getByTestId('folder-page').getByTestId('past-note')).toHaveText([/Weekly sync/])
  } finally { await b.app.close() }
})

test('24 folder icons and eight colors persist, label filed meetings without replacing their identity, and cancel without saving', async () => {
  const { app, page } = await launch()
  try {
    await withMeetings(app, page)
    await page.getByTestId('folder-create').click()
    await page.getByTestId('folder-name-input').fill('Design')
    await expect(page.getByRole('radiogroup', { name: 'Icon', exact: true }).getByRole('radio')).toHaveCount(24)
    await expect(page.getByRole('radiogroup', { name: 'Color', exact: true }).getByRole('radio')).toHaveCount(8)
    await page.getByTestId('folder-icon-palette').click()
    await page.getByTestId('folder-color-violet').click()
    await page.getByTestId('folder-name-save').click()
    const nav = folder(page, 'Design')
    await expect(nav.locator('[data-folder-icon=palette]')).toHaveAttribute('data-folder-color', 'violet')
    await expect(page.getByTestId('folder-heading-icon').locator('[data-folder-icon=palette]')).toBeVisible()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('past-note').filter({ hasText: 'Weekly sync' }).dragTo(nav.getByTestId('sidebar-folder-open'))
    const card = page.getByTestId('past-note').filter({ hasText: 'Weekly sync' })
    await expect(card.getByTestId('past-note-folder')).toHaveText('Design')
    await expect(card.getByTestId('past-note-folder')).toHaveAttribute('data-folder-color', 'violet')
    await expect(card.locator('.meeting-identity')).toBeVisible()
    await expect(card.locator('.meeting-identity[data-folder-color], .meeting-identity [data-folder-icon]')).toHaveCount(0)
    await card.click()
    await expect(page.getByTestId('note-folders').locator('[data-folder-icon=palette]')).toBeVisible()

    await nav.getByTestId('sidebar-folder-more').click()
    await page.getByTestId('sidebar-folder-appearance').click()
    await expect(page.getByTestId('folder-icon-palette')).toBeFocused()
    await page.getByTestId('folder-icon-rocket').click()
    await page.getByTestId('folder-color-blue').click()
    await page.keyboard.press('Escape')
    await expect(nav.locator('[data-folder-icon=palette]')).toBeVisible()
    await expect(nav.getByTestId('sidebar-folder-more')).toBeFocused()

    await nav.getByTestId('sidebar-folder-open').click()
    await page.getByTestId('folder-heading-icon').click()
    await page.getByTestId('folder-icon-folder').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('folder-icon-star')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('folder-color-amber').click()
    await page.getByTestId('folder-appearance-save').click()
    await page.reload()
    await expect(nav.locator('[data-folder-icon=star]')).toHaveAttribute('data-folder-color', 'amber')
    await nav.getByTestId('sidebar-folder-open').click()
    await expect(page.getByTestId('folder-heading-icon').locator('[data-folder-icon=star]')).toBeVisible()
    await expect(card).toBeVisible()
    await expect(card.getByTestId('past-note-folder')).toHaveCount(0)
    await expect(card.locator('.meeting-identity[data-folder-color], .meeting-identity [data-folder-icon]')).toHaveCount(0)
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('Design')
    await expect(page.getByTestId('search').locator('[data-folder-icon=star]').last()).toBeVisible()
  } finally { await app.close() }
})
