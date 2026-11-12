import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: Windows and Linux polish (shortcuts with Ctrl, the tray menu). The Mac CI tries them through YOGURT_FAKE_PLATFORM.
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string> = {}) =>
  electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-e2e-')), ...env } })
const fake = (app: ElectronApplication, name: string, ...args: unknown[]) =>
  app.evaluate((_e, [n, a]) => (globalThis as unknown as { __fake__: Record<string, (...x: unknown[]) => unknown> }).__fake__[n as string](...(a as unknown[])), [name, args] as const)

for (const platform of ['win32', 'linux']) {
  test(`@everywhere on ${platform}: shortcuts use Ctrl, in the labels and on the keyboard`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('search-open')).toHaveAttribute('title', 'Search (Ctrl+K)')
      await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+S')
      await page.keyboard.press('Control+Slash')
      const help = page.getByTestId('shortcuts-dialog')
      await expect(help).toBeVisible()
      await expect(help).toContainText('Ctrl+K')
      await expect(help).toContainText('Ctrl+Shift+C')
      await expect(help).not.toContainText('⌘')
      await expect(help).not.toContainText('Hide Others')
      await page.keyboard.press('Escape')
      await expect(help).toHaveCount(0)
      await page.keyboard.press('Control+k')
      await expect(page.getByTestId('search')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('search')).toHaveCount(0)
      await page.keyboard.press('Control+Shift+S')
      await expect(page.getByTestId('sidebar-expand')).toBeVisible()
      await page.keyboard.press('Control+2')
      await expect(page.getByTestId('nav-chat')).toHaveAttribute('aria-current', 'page')
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: the tray menu opens Yogurt, records and quits, with Ctrl for Settings, and pauses no music`, async () => {
    const app = await launch({ YOGURT_FAKE_PLATFORM: platform })
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      expect(await fake(app, 'tray')).toEqual(expect.arrayContaining(['Start recording', 'Open Yogurt', 'Settings…', 'Quit Yogurt']))
      expect(await fake(app, 'trayAccelerators')).toEqual({ 'Settings…': 'Ctrl+,' })
      await fake(app, 'trayClick', 'new')
      await expect.poll(() => fake(app, 'tray')).toContain('Finish recording')
      // no music player is paused off a Mac (capabilities.mediaPause)
      expect(((await fake(app, 'main')) as { mediaCalls: string[][] }).mediaCalls).toEqual([])
      await fake(app, 'trayClick', 'stop')
      await expect.poll(() => fake(app, 'tray')).toContain('Start recording')
    } finally { await app.close() }
  })
}
