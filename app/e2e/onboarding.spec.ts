import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

test('first run: progress while the models arrive, then the home screen', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  // slow enough to see the bar (only the speech model is waited for)
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_STEP_MS: '500' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('onboarding')).toBeVisible()
    await expect(page.getByTestId('wordmark')).toBeVisible()
    await expect(page.getByTestId('step-title')).toHaveText('Almost ready')
    const bar = page.getByTestId('setup-progress')
    await expect(bar).toBeVisible()
    // moves above zero before it is done
    await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('onboarding')).toHaveCount(0)
    // the speech model is on disk; no voice models are fetched any more
    expect(readdirSync(join(userData, 'models', 'asr')).some((f) => f.endsWith('.bin'))).toBe(true)
    expect(existsSync(join(userData, 'models', 'diarizer'))).toBe(false)
  } finally { await app.close() }
})

test('with fake downloads setup finishes by itself, and the second launch goes straight to home', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const env = { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData }
  for (let i = 0; i < 2; i++) {
    const app = await electron.launch({ args: [main], env })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    } finally { await app.close() }
  }
})

test('first run records as soon as speech and speakers are in; notes say they are getting ready, then write themselves once the notes model lands', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  // the notes model takes its time: everything else is quick; it lands well after the meeting and the question, however slow the machine
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_NOTES_MODEL_MS: '40000' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 10_000 })
    expect(readdirSync(join(userData, 'models')).includes('llm') && readdirSync(join(userData, 'models', 'llm')).some((f) => f.endsWith('.gguf'))).toBe(false)
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await page.getByTestId('note-stop').click()
    await page.getByRole('tab', { name: 'Summary', exact: true }).click()
    await expect(page.getByTestId('note-enhanced-model-download')).toContainText('Lynote NoteTaker is still downloading its AI model.')
    // a question waits too, and says why (never as if notes were being written)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('What was decided?')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-turn').last()).toContainText("Waiting for Lynote NoteTaker's AI to finish downloading")
    await expect(page.getByTestId('chat-turn').last()).not.toContainText('Generating notes')
    // the notes model lands: the notes are written without anyone asking, and the question is answered
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    await expect(page.getByTestId('chat-turn').last()).toContainText('Tuesday', { timeout: 30_000 })
  } finally { await app.close() }
})

// ---- the launch screen, the intro, each permission step, Finish setup and the recording's own message ----

const launchWith = (userData: string, env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
const fake = (app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as any).__fake__[fn as string](arg), [fn, arg] as const)
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
const firstRun = { YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' }
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

test('a slow start shows the launch screen until Lynote NoteTaker is ready, then goes', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(userData, { YOGURT_FAKE_BOOT_MS: '2000' })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('boot-screen')).toBeVisible()
    await expect(page.getByTestId('boot-screen')).toHaveAttribute('aria-label', 'Lynote NoteTaker')
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('boot-screen')).toHaveCount(0)
  } finally { await app.close() }
})

test('a quick start goes straight to home, with the launch screen gone', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(userData)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('boot-screen')).toHaveCount(0)
  } finally { await app.close() }
})

test('the welcome says what Lynote NoteTaker is on one screen, and Get started goes on to the permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, firstRun)
  try {
    const page = await app.firstWindow()
    const intro = page.getByTestId('intro-page')
    await expect(intro.getByRole('heading')).toHaveText('Take note.')
    await expect(page.getByTestId('intro-next')).toBeFocused()
    await expect(page.getByTestId('intro-next')).toHaveText('Get started')
    await expect(page.getByRole('img', { name: 'Step 1 of 5', exact: true })).toBeVisible()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await expect.poll(() => settingsOf(dir).introSeen).toBe(true)
    // no account, no terms, no login step: only what the Mac needs
    await expect(page.getByRole('img', { name: 'Step 2 of 5', exact: true })).toBeVisible()
  } finally { await app.close() }
  // reopened halfway (say, after a restart for a permission): straight back to the permissions
  const again = await launchWith(dir, firstRun)
  try {
    const page = await again.firstWindow()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await expect(page.getByTestId('intro-page')).toHaveCount(0)
  } finally { await again.close() }
})

test('every screen uses the same buttons: Allow and Not now are the same height and sit in the same place on every step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, firstRun)
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
    await page.waitForTimeout(500)
    const start = await box('intro-next')
    await page.getByTestId('intro-next').click()
    const step = page.getByTestId('onboarding-step')
    let first: { allow: { x: number; y: number; height: number }; later: { x: number; y: number; height: number } } | undefined
    for (const screen of ['record', 'calendar', 'notifications', 'accessibility']) {
      await expect(step).toHaveAttribute('data-step', screen)
      // the step's entrance settles before measuring
      await page.waitForTimeout(500)
      const allow = await box('step-allow'), later = await box('step-later')
      expect(later.height).toBe(allow.height)
      expect(allow.height).toBe(start.height)
      if (first) {
        expect(allow.y).toBe(first.allow.y)
        expect(allow.x).toBe(first.allow.x)
        expect(later.y).toBe(first.later.y)
      } else first = { allow, later }
      await page.getByTestId('step-later').click()
    }
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
  } finally { await app.close() }
})

test('every permission step leads with what it gives, Allow asks the Mac, and Accessibility goes through System Settings and back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, firstRun)
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    const step = page.getByTestId('onboarding-step')
    await expect(step).toHaveAttribute('data-step', 'record')
    await expect(page.getByTestId('step-title')).toHaveText('Hear the whole call')
    // the picture: you through the mic, the others through the Mac's sound
    await expect(page.getByTestId('record-art')).toContainText('You')
    await expect(page.getByTestId('record-art')).toContainText('Everyone else')
    for (const screen of ['record', 'calendar', 'notifications']) {
      await expect(step).toHaveAttribute('data-step', screen)
      await expect(page.getByTestId('step-title')).not.toHaveText(/^Can Lynote NoteTaker/)
      await expect(page.getByTestId('step-later')).toHaveText('Not now')
      await expect(page.getByTestId('step-allow')).toHaveText('Allow')
      await page.getByTestId('step-allow').click()
    }
    // one Allow asked the Mac for both
    expect(await fake(app, 'permissions')).toMatchObject({ mic: 'granted', systemAudio: 'granted' })
    await expect(step).toHaveAttribute('data-step', 'accessibility')
    await expect(page.getByTestId('step-title')).toHaveText('See who said what')
    // the picture of why: You and Them becoming names
    await expect(page.getByTestId('speaker-names-art')).toContainText('Them')
    await expect(page.getByTestId('speaker-names-art')).toContainText('Chris')
    await page.getByTestId('step-allow').click()
    // only System Settings turns it on: the pane opens, with where to click
    await expect(page.getByTestId('settings-guide')).toBeVisible()
    await expect(page.getByTestId('settings-window-art')).toContainText('Accessibility')
    await expect(page.getByTestId('step-title')).toHaveText('Turn on Lynote NoteTaker in System Settings')
    await expect(page.getByTestId('step-reason')).toHaveText('In Accessibility, find Lynote NoteTaker and turn it on.')
    expect((await fake(app, 'main') as { systemSettings: string[] }).systemSettings).toEqual([expect.stringContaining('Privacy_Accessibility')])
    // turned on there: noticed without a click (the poll), and Continue goes on
    await fake(app, 'permission', ['accessibility', 'granted'])
    await expect(page.getByTestId('step-title')).toHaveText('All set', { timeout: 5000 })
    await expect(page.getByTestId('step-allow')).toHaveText('Continue')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(await fake(app, 'permissions')).toEqual({ mic: 'granted', systemAudio: 'granted', calendar: 'granted', notifications: 'granted', accessibility: 'granted' })
    // open at login is never asked, and stays off
    expect(settingsOf(dir)).toMatchObject({ welcomed: true })
    expect(settingsOf(dir).openAtLogin).toBeFalsy()
    await expect(page.getByTestId('finish-setup')).toHaveCount(0)
  } finally { await app.close() }
})

test('turned off before: the step says so, opens System Settings with the guide, notices it on return, and can reopen Lynote NoteTaker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, { YOGURT_FAKE_PERMISSIONS: 'denied', YOGURT_FAKE_CALENDAR: 'granted' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-kind', 'mic')
    await expect(page.getByTestId('step-allow')).toHaveText('Open System Settings')
    await expect(page.getByTestId('step-access-status')).toContainText('only System Settings can turn it on')
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('settings-guide')).toBeVisible()
    await expect(page.getByTestId('step-reason')).toHaveText('In Microphone, find Lynote NoteTaker and turn it on.')
    await expect(page.getByTestId('settings-window-art')).toContainText('Microphone')
    expect((await fake(app, 'main') as { systemSettings: string[] }).systemSettings).toEqual([expect.stringContaining('Privacy_Microphone')])
    await page.getByText('Still not working?', { exact: true }).click()
    await page.getByTestId('settings-guide-relaunch').click()
    await expect.poll(async () => (await fake(app, 'main') as { relaunched: number }).relaunched).toBe(1)
    await fake(app, 'permission', ['mic', 'granted'])
    await focus(page)
    await expect(page.getByTestId('step-title')).toHaveText('All set')
    await page.getByTestId('step-allow').click()
    // the same screen goes on with the call audio, turned off before too: no prompt pops up, it waits for a click
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-kind', 'systemAudio')
    await expect(page.getByTestId('step-allow')).toHaveText('Open System Settings')
    // the call audio pane, and its own list
    await page.getByTestId('step-allow').click()
    await expect(page.getByTestId('step-reason')).toContainText('under System Audio Recording Only, turn on Lynote NoteTaker.')
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'notifications')
  } finally { await app.close() }
})

test('"Not now" everywhere: home lists what is missing, essentials first, and can be put away until something new goes missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, firstRun)
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    for (let i = 0; i < 4; i++) await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('finish-setup-open').click()
    const items = page.getByTestId('finish-setup-item')
    await expect(page.getByTestId('finish-setup-remaining')).toHaveText('4 left')
    await expect(page.getByTestId('finish-setup-progress')).toHaveCount(0)
    await expect(items).toHaveCount(4)
    await expect(page.locator('[data-testid="finish-setup-item"][data-kind="calendar"]')).toHaveCount(0)
    await expect(items.nth(0)).toHaveAttribute('data-kind', 'mic')
    await expect(items.nth(0).getByTestId('finish-setup-detail')).toHaveText('Captures your voice.')
    await expect(items.nth(1)).toHaveAttribute('data-kind', 'systemAudio')
    await expect(items.nth(2).getByTestId('finish-setup-detail')).toBeVisible()
    const originalHeight = await page.getByTestId('finish-setup').evaluate(el => el.getBoundingClientRect().height)
    for (const item of await items.all()) {
      await expect(item.locator('svg')).toHaveCount(0)
      await expect(item.getByTestId('finish-setup-fix')).toHaveText('Turn on')
      const detail = item.getByTestId('finish-setup-detail')
      await expect(detail).toBeVisible()
      expect(await detail.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap')
      expect(await detail.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await expect(page.getByTestId('finish-setup-close')).toHaveAttribute('title', 'Close')
    expect(await page.locator('.finish-setup-controls button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')))).toEqual(['More', 'Close'])
    await page.getByTestId('finish-setup-close').focus()
    expect(await page.getByTestId('finish-setup').evaluate(el => el.getBoundingClientRect().height)).toBe(originalHeight)
    expect(await page.getByTestId('finish-setup').evaluate(el => el.getBoundingClientRect().width)).toBe(340)
    // Closing the card never hides the sidebar checklist or writes dismissal state.
    await page.getByTestId('finish-setup-close').click()
    await expect(page.getByTestId('finish-setup')).toHaveCount(0)
    await expect(page.getByTestId('finish-setup-open')).toBeFocused()
    await expect(page.getByTestId('setup-hidden')).toHaveCount(0)
    await page.getByTestId('finish-setup-open').click()
    await page.getByTestId('finish-setup-more').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('finish-setup-hide')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('finish-setup-hide')).toHaveCount(0)
    await expect(page.getByTestId('finish-setup')).toBeVisible()
    await expect(page.getByTestId('finish-setup-more')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('finish-setup')).toHaveCount(0)
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
    await page.getByTestId('finish-setup-open').click()
    // a Mac prompt: Turn on asks, and the row goes
    await items.nth(0).getByTestId('finish-setup-fix').click()
    await expect(items).toHaveCount(3)
    await expect(page.getByTestId('finish-setup-remaining')).toHaveText('3 left')
    expect((await fake(app, 'permissions') as Record<string, string>).mic).toBe('granted')
    // System Settings: the guide in a dialog, closed by itself once it is on
    await page.locator('[data-testid="finish-setup-item"][data-kind="accessibility"]').getByTestId('finish-setup-fix').click()
    await expect(page.getByTestId('permission-guide')).toBeVisible()
    await expect(page.getByTestId('permission-guide')).toContainText('Accessibility')
    await fake(app, 'permission', ['accessibility', 'granted'])
    await expect(page.getByTestId('permission-guide')).toHaveCount(0, { timeout: 5000 })
    await expect(items).toHaveCount(2)
    await page.getByTestId('finish-setup-more').click()
    await page.getByTestId('finish-setup-hide').click()
    await expect(page.getByTestId('finish-setup')).toHaveCount(0)
    await expect.poll(() => settingsOf(dir).setupDismissed).toEqual(['systemAudio', 'notifications'])
    await page.getByTestId('setup-undo').click()
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
    expect(settingsOf(dir).setupDismissed).toEqual([])
    await page.getByTestId('finish-setup-open').click()
    await page.getByTestId('finish-setup-more').click()
    await page.getByTestId('finish-setup-hide').click()
    await expect(page.getByTestId('finish-setup-open')).toHaveCount(0)
    // the mic turned off later: something new is missing, so it is back
    await fake(app, 'permission', ['mic', 'denied'])
    await focus(page)
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
    await page.getByTestId('finish-setup-open').click()
    await expect(items.nth(0)).toHaveAttribute('data-kind', 'mic')
  } finally { await app.close() }
})

test('starting a recording without the mic says so under the note, with a button that turns it on; one never asked is asked then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  // the mic was turned off; call audio was put off in the first run
  const app = await launchWith(dir, { YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_MIC: 'denied' })
  try {
    const page = await app.firstWindow()
    await page.getByTestId('intro-next').click()
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await fake(app, 'permission', ['systemAudio', 'unknown'])
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    const hint = page.getByTestId('rec-hint')
    await expect(hint).toHaveAttribute('data-code', 'no-mic')
    await expect(hint).toContainText("Lynote NoteTaker can't hear your mic.")
    // call audio was never asked: asked as the recording started (the fake Mac says yes), so no message for it
    await expect.poll(async () => (await fake(app, 'permissions') as Record<string, string>).systemAudio).toBe('granted')
    await hint.getByTestId('rec-hint-fix').click()
    await expect(page.getByTestId('permission-guide')).toBeVisible()
    // never reopen mid-recording
    await expect(page.getByTestId('settings-guide-relaunch')).toHaveCount(0)
    await fake(app, 'permission', ['mic', 'granted'])
    await expect(page.getByTestId('permission-guide')).toHaveCount(0, { timeout: 5000 })
    await expect(hint).toContainText('Microphone is on. Your next recording uses it.')
  } finally { await app.close() }
})

test('a "no" at the Mac\'s prompt when recording starts says so too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await launchWith(dir, { YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_ANSWER: 'deny' })
  try {
    const page = await app.firstWindow()
    // nothing to ask: the intro, then home
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    await fake(app, 'permission', ['systemAudio', 'unknown'])
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('rec-hint')).toHaveAttribute('data-code', 'no-system-audio')
    await expect(page.getByTestId('rec-hint-fix')).toBeVisible()
  } finally { await app.close() }
})
