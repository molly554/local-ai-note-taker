import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(env: Record<string, string> = {}) {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-commands-')), ...env,
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('the sidebar shortcut, native View menu, command palette and shortcut reference stay in sync', async () => {
  const { app, page } = await launch()
  try {
    const toggle = page.locator('.workspace-sidebar-toggle')
    const menu = () => app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('toggle-sidebar')
      return item ? { label: item.label, accelerator: item.accelerator, enabled: item.enabled } : null
    })
    const clickMenu = () => app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('toggle-sidebar')!
      item.click(item, undefined, { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, triggeredByAccelerator: false })
    })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+Meta+S')
    await expect(toggle).toHaveAttribute('title', /⌃⌘S/)
    await expect.poll(menu).toEqual({ label: 'Hide Sidebar', accelerator: 'Control+Command+S', enabled: true })
    await page.keyboard.press('Control+Meta+s')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(menu).toMatchObject({ label: 'Show Sidebar' })
    await clickMenu()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Meta+k')
    const command = page.getByTestId('command-sidebar')
    await expect(command).toContainText('Hide Sidebar')
    await expect(command.locator('kbd')).toHaveText('⌃⌘S')
    await command.click()
    await expect(page.getByTestId('search')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Meta+/')
    await expect(page.getByTestId('shortcut-row').filter({ hasText: 'Toggle Sidebar' })).toContainText('⌃⌘S')
    // Neither route into the shortcut changes the workspace behind a modal.
    await page.keyboard.press('Control+Meta+s')
    await clickMenu()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0)
    // innerWidth changes before the resize event lands, so wait for the event or it can close the sidebar opened below
    await page.evaluate(() => { (window as unknown as { narrowed: Promise<void> }).narrowed = new Promise(done => addEventListener('resize', function on() { if (innerWidth === 720) { removeEventListener('resize', on); done() } })) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await page.evaluate(() => (window as unknown as { narrowed: Promise<void> }).narrowed)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Control+Meta+s')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(menu).toMatchObject({ label: 'Hide Sidebar' })
    // Only narrowing past the breakpoint closes it; a later resize while narrow leaves the person's choice alone.
    const resized = page.evaluate(() => new Promise(done => addEventListener('resize', done, { once: true })))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(720, 600))
    await resized
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await page.locator('.workspace-sidebar-gap').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false)
  } finally { await app.close() }
})

test('page shortcuts are taught in the palette, work there, and respect modal editing', async () => {
  const { app, page } = await launch()
  try {
    for (const [id, shortcut, key, screen] of [
      ['chat', '⌘2', 'Meta+2', 'chat-page'], ['trash', '⌘3', 'Meta+3', 'trash-page'],
      ['settings', '⌘,', 'Meta+,', 'settings'], ['meetings', '⌘1', 'Meta+1', 'home'],
    ]) {
      await page.keyboard.press('Meta+k')
      const command = page.getByTestId(`command-${id}`)
      await expect(command.locator('kbd')).toHaveText(shortcut)
      expect((await command.locator('kbd').boundingBox())!.x).toBeGreaterThan((await command.locator('.command-label').boundingBox())!.x)
      await page.keyboard.press(key)
      await expect(page.getByTestId('search')).toHaveCount(0)
      await expect(page.getByTestId(screen)).toBeVisible()
    }
    await page.getByTestId('folder-create').click()
    await page.getByTestId('folder-name-input').fill('123')
    await page.keyboard.press('Meta+2')
    await expect(page.getByTestId('folder-name-input')).toHaveValue('123')
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('folder-name-input')).toHaveCount(0)
    await page.keyboard.press('Meta+/')
    for (const label of ['Meetings', 'Ask', 'Trash']) await expect(page.getByTestId('shortcut-row').filter({ has: page.getByText(label, { exact: true }) })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0)
    const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(0))
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByTestId('note-notes-tab').click()
    await page.getByTestId('note-mine').fill('Keep this draft when switching pages.')
    await page.keyboard.press('Meta+2')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect.poll(() => page.evaluate(id => window.yogurt.notes.get(id).then(n => n.mine), id)).toBe('Keep this draft when switching pages.')
  } finally { await app.close() }
})

test('the command palette opens pages and folders and changes appearance and settings', async () => {
  const { app, page } = await launch()
  try {
    const folder = await page.evaluate(() => window.yogurt.folders.create('Standup'))
    const command = async (query: string, id: string) => {
      await page.keyboard.press('Meta+k')
      await page.getByTestId('search-input').fill(query)
      await page.getByTestId(`command-${id}`).click()
      await expect(page.getByTestId('search')).toHaveCount(0)
    }
    await command('settings', 'settings')
    await expect(page.getByTestId('settings')).toBeVisible()
    await command('dark', 'theme-dark')
    expect((await page.evaluate(() => window.yogurt.settings.get())).theme).toBe('dark')
    await expect(page.getByTestId('settings-theme')).toHaveValue('dark')
    await command('light', 'theme-light')
    await expect(page.getByTestId('settings-theme')).toHaveValue('light')
    const before = await page.evaluate(() => window.yogurt.settings.get())
    await command('login', 'login')
    expect((await page.evaluate(() => window.yogurt.settings.get())).openAtLogin).toBe(!before.openAtLogin)
    await command('Standup', `folder-${folder!.id}`)
    await expect(page.getByTestId('folder-title')).toHaveText('Standup')
    await command('chat', 'chat')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('trash')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('trash-page')).toBeVisible()
  } finally { await app.close() }
})

test('appearance commands omit the saved choice and switch between all three modes', async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(() => window.yogurt.settings.setTheme('system'))
    for (const [current, next, query] of [
      ['system', 'dark', 'Dark theme'],
      ['dark', 'light', 'Light theme'],
      ['light', 'system', 'Match my Mac'],
    ] as const) {
      await page.keyboard.press('Meta+k')
      await page.getByTestId('search-input').fill('Appearance')
      await expect(page.locator('[data-testid^="command-theme-"]')).toHaveCount(2)
      await expect(page.getByTestId(`command-theme-${current}`)).toHaveCount(0)
      await page.getByTestId('search-input').fill(query)
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('search')).toHaveCount(0)
      expect((await page.evaluate(() => window.yogurt.settings.get())).theme).toBe(next)
    }
  } finally { await app.close() }
})

test('closing the palette cancels a pending Enter while search is still answering', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SEARCH_SLOW: '1' })
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await expect(page.getByTestId('past-note')).toBeVisible()
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('bud')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search')).toHaveCount(0)
    // The fake search replies after one second; a closed palette must not navigate then.
    await page.waitForTimeout(1200)
    await expect(page.getByTestId('home')).toBeVisible()
  } finally { await app.close() }
})

test('bracket history works in both directions, branches correctly, and keeps a note draft', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice(6)
    await page.getByTestId('note-notes-tab').click()
    await page.getByTestId('note-mine').fill('Keep this draft through navigation.')
    await page.keyboard.press('Meta+[')
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.press('Meta+]')
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByTestId('note-mine')).toContainText('Keep this draft through navigation.')
    expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).mine).toContain('Keep this draft through navigation.')
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.keyboard.press('Meta+[')
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.keyboard.press('Meta+]')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.getByTestId('nav-back').click()
    await expect(page.getByTestId('note')).toBeVisible()
    await page.getByTestId('nav-forward').click()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.keyboard.down('Meta')
    await page.keyboard.press('[')
    await page.keyboard.press('[')
    await page.keyboard.up('Meta')
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.down('Meta')
    await page.keyboard.press(']')
    await page.keyboard.press(']')
    await page.keyboard.up('Meta')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.getByTestId('folder-create').click()
    await expect(page.getByTestId('folder-name')).toBeVisible()
    await page.keyboard.press('Meta+[')
    await expect(page.getByTestId('folder-name')).toBeVisible()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.keyboard.press('Escape')
  } finally { await app.close() }
})

test('typing keeps the palette frame steady and replaces meeting and command results together', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SEARCH_SLOW: '1' })
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(8))
    await page.reload()
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    await page.keyboard.press('Meta+k')
    const palette = page.getByTestId('search')
    const input = page.getByTestId('search-input')
    await expect(palette.getByTestId('search-result')).toHaveCount(8)
    await page.evaluate(() => {
      const frames: number[][] = []
      const measure = () => {
        const panel = document.querySelector('[data-testid=search]')
        if (!panel) return
        const p = panel.getBoundingClientRect(), footer = panel.querySelector('.search-footer')!.getBoundingClientRect()
        frames.push([p.y, p.height, footer.y])
        requestAnimationFrame(measure)
      }
      ;(window as unknown as { paletteFrames: number[][] }).paletteFrames = frames
      requestAnimationFrame(measure)
    })
    await input.fill('sett')
    // While the delayed search is pending, retain one coherent result set instead of clearing its rows.
    await page.waitForTimeout(250)
    await expect(palette.getByTestId('search-result')).toHaveCount(8)
    await expect(palette.getByTestId('command-meetings')).toHaveCount(1)
    await expect(palette.getByTestId('search-result')).toHaveCount(0)
    await expect(palette.getByTestId('command-settings')).toBeVisible()
    await expect(palette.getByTestId('command-meetings')).toHaveCount(0)
    await input.fill('zzqx')
    await expect(palette.getByTestId('search-none')).toBeVisible()
    const frames = await page.evaluate(() => (window as unknown as { paletteFrames: number[][] }).paletteFrames)
    for (const i of [0, 1, 2]) expect(Math.max(...frames.map(f => f[i])) - Math.min(...frames.map(f => f[i]))).toBeLessThan(1)
    // Enter during a pending query uses the new command, not the retained results.
    await input.fill('settings')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('settings')).toBeVisible()
  } finally { await app.close() }
})

test('shortcut help opens from the palette and its footer, is searchable, and closes with Escape', async () => {
  const { app, page } = await launch()
  try {
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-input').fill('shortcuts')
    await expect(page.getByTestId('command-shortcuts')).toBeVisible()
    await page.getByTestId('command-shortcuts').click()
    const help = page.getByTestId('shortcuts-dialog')
    await expect(help).toBeVisible()
    await expect(help.getByRole('textbox')).toBeFocused()
    await help.getByRole('textbox').fill('forward')
    await expect(help.getByTestId('shortcut-row')).toHaveCount(1)
    await expect(help).toContainText('⌘]')
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await page.keyboard.press('Meta+k')
    await page.getByTestId('search-shortcuts').click()
    await expect(help).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Meta+/')
    await expect(help).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('home')).toBeVisible()
  } finally { await app.close() }
})

test('back and forward restore Settings and a paged meeting list to the same scroll positions', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(180))
    await page.reload()
    const library = page.locator('.native-library')
    await expect(page.getByTestId('past-note').first()).toBeVisible()
    // Load beyond the first page before leaving; restoring only the offset would clamp against 40 rows.
    await library.evaluate(el => el.scrollTop = el.scrollHeight)
    await expect.poll(() => page.getByTestId('past-note').count()).toBeGreaterThan(40)
    await library.evaluate(el => el.scrollTop = 2700)
    const homeTop = await library.evaluate(el => el.scrollTop)
    await page.keyboard.press('Meta+,')
    const settings = page.locator('.settings-scroll')
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.getByTestId('settings-shortcuts').scrollIntoViewIfNeeded()
    const settingsTop = await settings.evaluate(el => el.scrollTop)
    expect(settingsTop).toBeGreaterThan(500)
    await page.keyboard.press('Meta+[')
    await expect.poll(() => library.evaluate(el => el.scrollTop)).toBeCloseTo(homeTop, 0)
    await page.keyboard.press('Meta+]')
    await expect.poll(() => settings.evaluate(el => el.scrollTop)).toBeCloseTo(settingsTop, 0)
  } finally { await app.close() }
})


test('returning to a note keeps its reading tab and scroll position', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-notes-tab').click()
    await page.getByTestId('note-mine').fill(Array.from({ length: 70 }, (_, i) => `Discussion point ${i + 1}.`).join('\n\n'))
    const pane = page.locator('.note-notes-pane')
    await pane.evaluate(el => el.scrollTop = 640)
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBe(640)
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.keyboard.press('Meta+[')
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBe(640)
    await expect(page.getByTestId('note-mine')).toContainText('Discussion point 70.')
  } finally { await app.close() }
})
