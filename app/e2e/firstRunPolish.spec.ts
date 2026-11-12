import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const before = process.env.YOGURT_UI_REVIEW === 'before'
const main = join(import.meta.dirname, '../out/main/index.js')

test('download progress keeps its geometry as percentages and phases change', async ({}, info) => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-download-layout-')), YOGURT_FAKE_STEP_MS: '60000' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('setup-ready')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    if (!before) {
      await expect(page.getByTestId('download-blob')).toBeVisible()
      await expect(page.locator('.icon-rim')).toHaveAttribute('opacity', '1')
      await expect(page.locator('.goo-group')).not.toHaveAttribute('filter')
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      let initial: { x: number; y: number; width: number; height: number } | undefined
      for (const fraction of [.09, .1, .99, 1]) {
        await app.evaluate(({ BrowserWindow }, fraction) => BrowserWindow.getAllWindows()[0].webContents.send('setup:state', { phase: 'downloading', fraction }), fraction)
        await expect(page.getByTestId('setup-progress')).toHaveAttribute('aria-valuenow', String(Math.floor(fraction * 100)))
        const box = (await page.getByTestId('setup-progress').boundingBox())!
        if (initial && !before) expect(box).toEqual(initial)
        initial = box
        if (!before) await expect(page.getByTestId('setup-percent')).toContainText(fraction < 1 ? 'Downloading the transcription model' : 'Preparing the transcription model')
        if (fraction === .09 || fraction === 1) await page.screenshot({ path: info.outputPath(`download-${before ? 'before' : 'after'}-${colorScheme}-${fraction}.png`) })
      }
    }
  } finally { await app.close() }
})

test('first-run notification stands alone and help stays in a bounded disclosure', async ({}, info) => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-first-run-polish-')) } })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('intro-next').click()
    await page.getByTestId('step-later').click()
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'notifications')
    if (!before) {
      await expect(page.getByTestId('notice-art').locator('img')).toBeVisible()
      await expect(page.locator('.ob-desk')).toHaveCount(0)
      expect(await page.locator('.ob-prompt-countdown').evaluate(el => el.getAnimations().length)).toBe(0)
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: info.outputPath(`notification-art-${before ? 'before' : 'after'}-${colorScheme}.png`) })
      expect(await page.locator('.setup-screen').evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/)
    }
    await page.getByTestId('step-later').click()
    await page.getByTestId('step-allow').click()
    const help = page.locator('.ob-guide-help')
    await help.locator('summary').click()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      if (!before) expect(await help.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px')
      await page.screenshot({ path: info.outputPath(`permission-help-${before ? 'before' : 'after'}-${colorScheme}.png`) })
    }
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('finish-setup-open').click()
    if (!before) {
      await expect(page.locator('[data-kind="accessibility"] .finish-setup-detail')).toHaveText('Names speakers in your transcript.')
      await expect(page.getByTestId('finish-setup')).toHaveAccessibleName('Finish setup')
      await expect(page.getByTestId('finish-setup').getByRole('heading', { name: 'Finish setup' })).toBeVisible()
    }
    await page.screenshot({ path: info.outputPath(`finish-setup-${before ? 'before' : 'after'}.png`) })
  } finally { await app.close() }
})

test('the notification title stays inside its column at 720px in Finnish', async ({}, info) => {
  test.skip(before, 'The compact notification is only in the current build.')
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined', YOGURT_SYSTEM_LANGUAGES: 'fi', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-notice-finnish-')) } })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 520))
    await page.getByTestId('intro-next').click()
    await page.getByTestId('step-later').click()
    await page.getByTestId('step-later').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'notifications')
    const title = page.locator('.ob-prompt-label')
    await expect(title).toHaveText('Tehdäänkö muistiinpanoja?')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      const geometry = await title.evaluate(el => {
        const button = el.closest('.ob-prompt')!.querySelector('.ob-prompt-button')!
        const style = getComputedStyle(el)
        return { right: el.getBoundingClientRect().right, buttonLeft: button.getBoundingClientRect().left, clipped: el.scrollWidth > el.clientWidth, overflow: style.overflowX, ellipsis: style.textOverflow }
      })
      expect(geometry.right).toBeLessThan(geometry.buttonLeft)
      expect(geometry.clipped).toBe(true)
      expect(geometry.overflow).toBe('hidden')
      expect(geometry.ellipsis).toBe('ellipsis')
      await page.screenshot({ path: info.outputPath(`notification-finnish-720-${colorScheme}.png`) })
    }
  } finally { await app.close() }
})

test('hiding the checklist ignores repeat clicks and permission reads from before Hide or Undo', async () => {
  test.skip(before, 'Checklist Undo is only in the current build.')
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-checklist-race-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ welcomed: true }))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined', YOGURT_USER_DATA: dir } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const missing = await page.evaluate(() => window.yogurt.onboarding.nudge())
    const status = await page.evaluate(() => window.yogurt.permissions.status())
    await page.getByTestId('finish-setup-open').click()
    await expect(page.getByTestId('finish-setup')).toBeVisible()
    // Hold only these IPC responses, without slowing or replacing the app's renderer.
    await app.evaluate(({ ipcMain }, { missing, status }) => {
      let hidden = false, holdNudge = false, holdReads = true, hides = 0
      let finishHide: (() => void) | undefined
      const reads: (() => void)[] = [], nudges: (() => void)[] = []
      for (const channel of ['permissions:status', 'onboarding:dismiss-nudge', 'onboarding:restore-nudge', 'onboarding:nudge']) ipcMain.removeHandler(channel)
      ipcMain.handle('permissions:status', () => holdReads ? new Promise(resolve => reads.push(() => resolve(status))) : status)
      ipcMain.handle('onboarding:dismiss-nudge', () => { hides++; return new Promise<void>(resolve => { finishHide = () => { hidden = true; resolve() } }) })
      ipcMain.handle('onboarding:restore-nudge', () => { hidden = false })
      ipcMain.handle('onboarding:nudge', () => {
        const value = hidden ? [] : missing
        return holdNudge ? new Promise(resolve => nudges.push(() => resolve(value))) : value
      })
      ;(globalThis as any).__checklistRace = {
        stats: () => ({ hides, reads: reads.length, nudges: nudges.length }),
        finishHide: () => finishHide?.(), releaseReads: () => { holdReads = false; reads.splice(0).forEach(resolve => resolve()) },
        holdNudge: (on: boolean) => { holdNudge = on }, releaseNudges: () => nudges.splice(0).forEach(resolve => resolve()),
      }
    }, { missing, status })
    const gate = (action: string, value?: boolean) => app.evaluate((_e, [action, value]) => (globalThis as any).__checklistRace[action as string](value), [action, value])
    const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(async () => (await gate('stats')).reads).toBeGreaterThan(0)
    await page.getByTestId('finish-setup-more').click()
    await page.getByTestId('finish-setup-hide').evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
    await paint()
    await expect.poll(async () => (await gate('stats')).hides).toBe(1)
    await gate('finishHide')
    await expect(page.getByTestId('setup-hidden')).toHaveCount(1)
    await expect(page.getByTestId('finish-setup-open')).toHaveCount(0)
    await gate('releaseReads'); await paint()
    await expect(page.getByTestId('finish-setup-open')).toHaveCount(0)
    await gate('holdNudge', true)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(async () => (await gate('stats')).nudges).toBeGreaterThan(0)
    await gate('holdNudge', false)
    await page.getByTestId('setup-undo').click()
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
    await gate('releaseNudges'); await paint()
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
  } finally { await app.close() }
})

test('permission help starts collapsed and uses the same secondary action in onboarding and Settings', async ({}, info) => {
  test.skip(before, 'The revised help is only in the current build.')
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_PERMISSIONS: 'granted', YOGURT_FAKE_CALENDAR: 'granted', YOGURT_FAKE_NOTIFICATIONS: 'granted', YOGURT_FAKE_AX: 'denied', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-help-review-')) } })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('intro-next').click()
    await expect(page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'accessibility')
    await page.getByTestId('step-allow').click()
    for (const surface of ['onboarding', 'settings'] as const) {
      const help = page.locator('.ob-guide-help')
      await expect(help).toBeVisible()
      await expect(help).not.toHaveAttribute('open', '')
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect(page.locator('.ob-switch-on')).toHaveCSS('background-color', colorScheme === 'light' ? 'rgb(111, 0, 255)' : 'rgb(183, 128, 255)')
        await expect(page.getByTestId('settings-guide-relaunch')).not.toBeVisible()
        if (surface === 'settings') expect(await help.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.left + 4, r.top + r.height / 2))
        })).toBe(true)
        await page.screenshot({ path: info.outputPath(`help-${surface}-${colorScheme}-collapsed.png`) })
        await help.locator('summary').click()
        const restart = page.getByTestId('settings-guide-relaunch')
        await expect(restart).toBeVisible()
        await expect(restart).toHaveCSS('height', '36px')
        await expect(restart).toHaveClass(/ob-button secondary/)
        await expect(restart.locator('svg')).toHaveCount(0)
        if (surface === 'onboarding') expect((await restart.boundingBox())!.height).toBe((await page.getByTestId('step-later').boundingBox())!.height)
        await page.screenshot({ path: info.outputPath(`help-${surface}-${colorScheme}-expanded.png`) })
        await help.locator('summary').click()
      }
      if (surface === 'onboarding') {
        await page.getByTestId('step-later').click()
        await expect(page.getByTestId('home')).toBeVisible()
        await page.getByTestId('finish-setup-open').click()
        await page.locator('[data-testid="finish-setup-item"][data-kind="accessibility"]').getByTestId('finish-setup-fix').click()
      } else {
        await help.locator('summary').click()
        await page.getByTestId('permission-guide-close').click()
        await expect(page.getByTestId('permission-guide')).toHaveCount(0)
        await page.locator('[data-testid="finish-setup-item"][data-kind="accessibility"]').getByTestId('finish-setup-fix').click()
        await expect(help).toBeVisible()
        await expect(help).not.toHaveAttribute('open', '')
        await expect(page.getByTestId('settings-guide-relaunch')).not.toBeVisible()
      }
    }
  } finally { await app.close() }
})
