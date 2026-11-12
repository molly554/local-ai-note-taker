import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (userData: string, env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
const fake = (app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as any).__fake__[fn as string](arg), [fn, arg] as const)
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
const firstRun = { YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' }

test('first run asks one thing at a time, then home; the next launch asks nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, firstRun)
  try {
    const page = await app.firstWindow()
    const step = page.getByTestId('onboarding-step')
    // Speech setup can finish before permission questions. It must not imply those steps are done.
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId('onboarding-setup-status')).toHaveText('Transcription ready')
    await page.getByTestId('intro-next').click()
    await expect(step).toHaveAttribute('data-step', 'record')
    await expect(page.getByRole('img', { name: 'Step 2 of 5', exact: true })).toBeVisible()
    // one Allow asks for the mic and the call audio, one after the other
    for (const screen of ['record', 'calendar', 'notifications']) {
      await expect(step).toHaveAttribute('data-step', screen)
      await expect(page.getByTestId('step-reason')).not.toBeEmpty()
      await expect(page.getByTestId('step-later')).toHaveText('Not now')
      await page.getByTestId('step-allow').click()
    }
    await expect(step).toHaveAttribute('data-step', 'accessibility')
    await page.getByTestId('step-allow').click()
    await fake(app, 'accessibility', true)
    // noticed by itself, then Continue
    await expect(page.getByTestId('step-allow')).toHaveText('Continue', { timeout: 5000 })
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    const st = await fake(app, 'permissions') as Record<string, string>
    expect(st).toEqual({ mic: 'granted', systemAudio: 'granted', calendar: 'granted', notifications: 'granted', accessibility: 'granted' })
    expect(settingsOf(dir)).toMatchObject({ welcomed: true })
  } finally { await app.close() }
  const again = await launch(dir, firstRun)
  try {
    const page = await again.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('onboarding-step')).toHaveCount(0)
  } finally { await again.close() }
})

test('"Not now" on every step still reaches home, with open at login left off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, firstRun)
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    for (let i = 0; i < 4; i++) await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(settingsOf(dir)).toMatchObject({ welcomed: true })
    expect(settingsOf(dir).openAtLogin).toBeFalsy()
    expect(await fake(app, 'permissions')).toMatchObject({ mic: 'unknown', calendar: 'unknown' })
  } finally { await app.close() }
})

test('turned off before: the step opens System Settings instead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_PERMISSIONS: 'denied', YOGURT_FAKE_CALENDAR: 'granted' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-kind', 'mic')
    await expect(page.getByTestId('step-allow')).toHaveText('Open System Settings')
    await page.getByTestId('step-allow').click()
    // Opening Settings is not permission. They can explicitly skip this step.
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await page.getByTestId('step-later').click()
    // Not now puts off the whole screen; calendar was already on: never asked
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'notifications')
    const m = await fake(app, 'main') as { systemSettings: string[] }
    expect(m.systemSettings).toEqual([expect.stringContaining('Privacy_Microphone')])
  } finally { await app.close() }
})

test('settings: granted permissions offer Manage, with open at login and theme controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    const rows = page.getByTestId('permission-row')
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'granted')
    await expect(rows.nth(1).getByTestId('permission-open')).toHaveText('Manage')
    await rows.nth(1).getByTestId('permission-open').click()
    expect((await fake(app, 'main') as { systemSettings: string[] }).systemSettings).toEqual([expect.stringContaining('Privacy_ScreenCapture')])
    // nothing technical: no model picker
    await expect(page.getByTestId('settings')).not.toContainText(/model/i)
    await expect(page.getByRole('switch', { name: 'Finish recording when the call ends', exact: true })).toBeChecked()
    await expect(page.getByTestId('settings')).toContainText('Automatically end the recording a few seconds after you hang up.')
    await page.getByTestId('login-toggle').click()
    await expect(page.getByTestId('login-toggle')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => settingsOf(dir).openAtLogin).toBe(true)
    const menuBar = page.getByRole('switch', { name: 'Show Lynote NoteTaker in the menu bar' })
    await expect(menuBar).toHaveAttribute('aria-checked', 'true')
    await menuBar.click()
    await expect(menuBar).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => settingsOf(dir).showInMenuBar).toBe(false)
    expect(await fake(app, 'tray')).toContain('Open Lynote NoteTaker')
    await menuBar.click()
    await expect(menuBar).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => settingsOf(dir).showInMenuBar).toBeUndefined()
    await page.getByTestId('settings-theme').selectOption('dark')
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    await expect.poll(() => settingsOf(dir).theme).toBe('dark')
    await page.getByTestId('settings-theme').selectOption('system')
    await expect.poll(() => settingsOf(dir).theme).toBeUndefined()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
  } finally { await app.close() }
})

test('settings: your name, the Mac\'s full name until changed; cleared, it goes back to that', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_FULL_NAME: 'Dana Reyes' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('settings-open').click()
    const name = page.getByTestId('settings-name')
    await expect(name).toHaveValue('Dana Reyes')
    await name.fill('  Dana  R. ')
    await name.press('Enter')
    await expect.poll(() => settingsOf(dir).myName).toBe('Dana R.')
    await name.fill('')
    await name.blur()
    await expect.poll(() => settingsOf(dir).myName).toBeUndefined()
    await expect(name).toHaveValue('Dana Reyes')
  } finally { await app.close() }
})

test('music pauses while recording and plays again after, only if it was playing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_MUSIC: '1' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('note')).toBeVisible()
    await expect.poll(async () => (await fake(app, 'main') as { mediaCalls: string[][] }).mediaCalls).toEqual([['media-pause']])
    await fake(app, 'trayClick', 'stop')
    await expect.poll(async () => (await fake(app, 'main') as { mediaCalls: string[][] }).mediaCalls).toEqual([['media-pause'], ['media-resume', 'com.apple.Music']])
  } finally { await app.close() }
})

test('menu bar: shows recording, and Lynote NoteTaker keeps running with its window closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'calendarEvents', [])
    await expect.poll(() => fake(app, 'tray')).toEqual(['Start recording', 'Ask Lynote NoteTaker', 'Recent', '', 'Open Lynote NoteTaker', 'Settings…', '', 'Quit Lynote NoteTaker'])
    await fake(app, 'trayClick', 'new')
    await expect(page.getByTestId('note')).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => fake(app, 'tray')).toEqual([expect.stringMatching(/^Recording: /), 'Pause recording', 'Finish recording', '', 'Ask Lynote NoteTaker', 'Open Lynote NoteTaker', 'Recent', 'Settings…', '', 'Quit Lynote NoteTaker'])
    await fake(app, 'trayClick', 'pause')
    await expect.poll(() => fake(app, 'tray')).toContain('Resume recording')
    await fake(app, 'trayClick', 'pause')
    await expect.poll(() => fake(app, 'tray')).toContain('Pause recording')
    await fake(app, 'trayClick', 'stop')
    await expect.poll(() => fake(app, 'tray')).toEqual(['Start recording', 'Ask Lynote NoteTaker', 'Recent', '', 'Open Lynote NoteTaker', 'Settings…', '', 'Quit Lynote NoteTaker'])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()))
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length)).toBe(0)
    // the main window again (not the widget or the card)
    await fake(app, 'trayClick', 'open')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length)).toBe(1)
    await expect.poll(() => app.windows().filter((w) => !w.isClosed() && /index\.html$|:\d+\/?$/.test(w.url())).length, { timeout: 15_000 }).toBe(1)
    const back = app.windows().find((w) => !w.isClosed() && /index\.html$|:\d+\/?$/.test(w.url()))!
    await expect(back.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
  } finally { await app.close() }
})

test('the dock icon and a second launch bring back a closed main window with the tray hidden, even while recording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.evaluate(() => window.yogurt.settings.setShowInMenuBar(false))
    expect(settingsOf(dir).showInMenuBar).toBe(false)
    await fake(app, 'trayClick', 'new')
    await expect(page.getByTestId('note')).toBeVisible({ timeout: 15_000 })
    // the main window is the big one (the widget and the card are small)
    const mainCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getBounds().width >= 700 && w.isVisible()).length)
    for (const event of ['activate', 'second-instance']) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getBounds().width >= 700).forEach((w) => w.close()))
      await expect.poll(mainCount).toBe(0)
      // the recording widget is still up, so the app has windows
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)
      await app.evaluate(({ app }, e) => { app.emit(e as 'activate') }, event)
      await expect.poll(mainCount).toBe(1)
    }
    // Also cover no retained main window (e.g. first opened from a login-only launch).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getBounds().width >= 700).forEach((w) => w.destroy()))
    await expect.poll(mainCount).toBe(0)
    await app.evaluate(({ app }) => { app.emit('activate') })
    await expect.poll(mainCount).toBe(1)
    expect(settingsOf(dir).showInMenuBar).toBe(false)
    await fake(app, 'trayClick', 'stop')
    await expect.poll(() => fake(app, 'tray')).toContain('Start recording')
  } finally { await app.close() }
})

test('the first run never asks about music, even with a player running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { ...firstRun, YOGURT_FAKE_PLAYER: '1' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    const step = page.getByTestId('onboarding-step')
    for (const kind of ['record', 'calendar', 'notifications', 'accessibility']) {
      await expect(step).toHaveAttribute('data-step', kind)
      // the next question is ready for the keyboard
      await expect(page.getByTestId('step-allow')).toBeFocused()
      await page.getByTestId(kind === 'accessibility' ? 'step-later' : 'step-allow').click()
    }
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect((await fake(app, 'main') as { mediaCalls: string[][] }).mediaCalls).toEqual([])
  } finally { await app.close() }
})

test('quitting while recording plays the music again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_MUSIC: '1' })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  await fake(app, 'trayClick', 'new')
  await expect.poll(async () => (await fake(app, 'main') as { mediaCalls: string[][] }).mediaCalls).toEqual([['media-pause']])
  await app.close()
  expect(readFileSync(join(dir, 'fake-media.log'), 'utf8').trim().split('\n')).toEqual(['media-pause', 'media-resume com.apple.Music'])
})

test('managed Macs and notifications already asked read plainly in Settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_MIC: 'restricted', YOGURT_FAKE_CALENDAR: 'granted' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    // the managed mic is never a question: the screen asks only for the call audio
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-kind', 'systemAudio')
    for (let i = 0; i < 2; i++) await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'accessibility')
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('settings-open').click()
    const mic = page.locator('[data-testid="permission-row"][data-kind="mic"]')
    await expect(mic).toHaveAttribute('data-status', 'restricted')
    await expect(mic).toContainText('Managed by your organization')
    await expect(mic.getByTestId('permission-open')).toHaveCount(0)
    await expect(page.locator('[data-testid="permission-row"][data-kind="notifications"]')).toHaveAttribute('data-status', 'granted')
  } finally { await app.close() }
})

test('names from calls: optional, asked with the Mac\'s own prompt once, then only System Settings turns it on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_NOTIFICATIONS: 'granted', YOGURT_FAKE_AX: 'denied' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'accessibility')
    await expect(page.getByTestId('step-reason')).toHaveText('Lynote NoteTaker reads the names Zoom, Meet and Teams show, so your transcript says who spoke instead of Them.')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('settings-guide')).toBeVisible()
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(settingsOf(dir).axAsked).toBe(true)
    await page.getByTestId('settings-open').click()
    const row = page.locator('[data-testid="permission-row"][data-kind="accessibility"]')
    await expect(row).toHaveAttribute('data-status', 'denied')
    await expect(row).toContainText('Names from your calls')
    await row.getByTestId('permission-open').click()
    // once from the first-run step, once from here
    await expect.poll(async () => (await fake(app, 'main') as { systemSettings: string[] }).systemSettings).toEqual([expect.stringContaining('Privacy_Accessibility'), expect.stringContaining('Privacy_Accessibility')])
    await expect(row).toHaveAttribute('data-status', 'denied')
  } finally { await app.close() }
})

test('notifications asked once are not asked again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_NOTIFICATIONS: 'unknown' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'notifications')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect((await page.evaluate(() => window.yogurt.permissions.status())).notifications).toBe('granted')
  } finally { await app.close() }
})

test('Accessibility is rechecked on return from Settings before continuing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir, { YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_AX: 'denied' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'accessibility')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('settings-guide')).toBeVisible()
    await fake(app, 'accessibility', true)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('step-allow')).toHaveText('Continue')
    await expect(page.getByTestId('step-title')).toHaveText('All set')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('settings-open').click()
    const row = page.locator('[data-testid="permission-row"][data-kind="accessibility"]')
    await expect(row).toHaveAttribute('data-status', 'granted')
    await fake(app, 'accessibility', false)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row).toHaveAttribute('data-status', 'denied')
  } finally { await app.close() }
})

test('appearance: one compact select changes and saves all three choices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.keyboard.press('Meta+Comma')
    await expect(page.getByTestId('settings')).toBeVisible()
    const select = page.getByRole('combobox', { name: 'Appearance', exact: true })
    await expect(page.locator('.settings-theme-preview')).toHaveCount(0)
    await expect(select.locator('option')).toHaveCount(3)
    for (const mode of ['light', 'dark', 'system']) {
      await select.selectOption(mode)
      await expect(select).toHaveValue(mode)
      await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(mode)
      await expect.poll(() => settingsOf(dir).theme).toBe(mode === 'system' ? undefined : mode)
    }
    await select.focus()
    await expect(select).toBeFocused()
    await page.reload()
    await expect(select).toHaveValue('system')
  } finally { await app.close() }
})

test('settings permission statuses and actions stay consistent without claiming unknown grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    for (const [kind, access] of [['mic', 'unknown'], ['systemAudio', 'denied'], ['calendar', 'granted'], ['notifications', 'asked'], ['accessibility', 'unknown']]) {
      await fake(app, 'permission', [kind, access])
    }
    await page.keyboard.press('Meta+Comma')
    const row = (kind: string) => page.locator(`[data-testid="permission-row"][data-kind="${kind}"]`)
    await expect(row('mic').getByTestId('permission-status')).toHaveCount(0)
    for (const [kind, status] of [['systemAudio', 'Off'], ['calendar', 'On'], ['notifications', 'Check in Settings'], ['accessibility', 'Not set up']]) {
      await expect(row(kind).getByTestId('permission-status')).toHaveText(status)
    }
    await fake(app, 'permission', ['mic', 'restricted'])
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row('mic').getByTestId('permission-status')).toHaveText('Managed by your organization')
    await expect(row('mic').getByRole('button')).toHaveCount(0)
    await fake(app, 'permission', ['mic', 'unknown'])
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    for (const kind of ['mic', 'systemAudio', 'notifications', 'accessibility']) {
      await expect(row(kind).getByRole('button')).toHaveClass(/\bprimary\b/)
    }
    await expect(row('calendar').getByRole('button')).toHaveText('Manage')
    await expect(row('calendar').getByRole('button')).not.toHaveClass(/\bprimary\b/)
    await expect(row('systemAudio').getByRole('button')).toHaveText('Turn on')
    await row('accessibility').getByTestId('permission-open').click()
    expect((await fake(app, 'main') as { systemSettings: string[] }).systemSettings.at(-1)).toContain('Privacy_Accessibility')
    await row('systemAudio').getByTestId('permission-open').click()
    await expect(row('systemAudio').getByTestId('permission-status')).toHaveText('Off')
    await row('mic').getByTestId('permission-ask').click()
    await expect(row('mic').getByTestId('permission-status')).toHaveText('On')
    await expect(row('mic').getByRole('button')).toHaveText('Manage')
    await expect(row('mic').getByRole('button')).not.toHaveClass(/\bprimary\b/)
    await fake(app, 'permission', ['systemAudio', 'granted'])
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row('systemAudio').getByTestId('permission-status')).toHaveText('On')
    await expect(row('notifications').getByTestId('permission-status')).toHaveText('Check in Settings')
    await expect(row('notifications').getByRole('button')).toHaveText('Open System Settings')
    await fake(app, 'permission', ['notifications', 'unknown'])
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(row('notifications').getByTestId('permission-status')).toHaveCount(0)
    await expect(row('notifications').getByRole('button')).toHaveText('Turn on')
    await row('notifications').getByTestId('permission-ask').click()
    expect((await page.evaluate(() => window.yogurt.permissions.status())).notifications).toBe('granted')
    await expect(row('notifications').getByTestId('permission-status')).toHaveText('On')
    await expect(row('notifications').getByRole('button')).toHaveText('Manage')
  } finally { await app.close() }
})

test('menu bar: next event prepares its note, Ask uses note context, Recent and Settings navigate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launch(dir)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const now = Date.now()
    await fake(app, 'calendarEvents', [{ id: 'tray-event', title: 'Launch planning', start: new Date(now - 60000).toISOString(), end: new Date(now + 3600000).toISOString(), attendees: [{ name: 'Dana', email: 'dana@example.com' }], url: 'https://meet.google.com/abc-defg-hij' }])
    await expect.poll(() => fake(app, 'tray')).toContain('Now: Launch planning')
    await expect.poll(() => fake(app, 'tray')).toContain('Join and record')
    await fake(app, 'trayClick', 'next')
    await expect(page.getByTestId('note-title')).toHaveText('Launch planning')
    await expect(page.getByTestId('note-start')).toBeVisible()
    const route = await page.evaluate(() => window.yogurt.nav.current())
    await fake(app, 'trayClick', 'ask')
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await fake(app, 'trayClick', 'settings')
    await expect(page.getByTestId('settings')).toBeVisible()
    await fake(app, 'trayClick', `note:${route.slice(6)}`)
    await expect(page.getByTestId('note-title')).toHaveText('Launch planning')
    await fake(app, 'trayClick', 'join')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await page.evaluate(() => window.yogurt.nav.current())).toBe(route)
    await fake(app, 'trayClick', 'stop')
    await page.getByTestId('nav-home').click()
    await fake(app, 'trayClick', 'ask')
    await expect(page.getByTestId('chat-page')).toBeVisible()
  } finally { await app.close() }
})
