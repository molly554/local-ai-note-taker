import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

/** system: the Mac's languages, as the Mac lists them */
async function launch(system: string, userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_SYSTEM_LANGUAGES: system } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const tray = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __fake__: { tray(): string[] } }).__fake__.tray())
const menuBar = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [])

test('the interface follows the Mac’s language until one is picked', async () => {
  const { app, page } = await launch('ja-JP,en-US')
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-heading')).toHaveText('設定')
    const picker = page.getByTestId('settings-app-language')
    await expect(picker).toHaveValue('')
    // the first choice says which language the Mac has, in that language's own name
    await expect(picker.locator('option').first()).toContainText('日本語')
    await expect(picker.locator('option')).toHaveCount(33)
  } finally { await app.close() }
})

test('picking a language in Settings changes everything at once, menus too, and stays after a relaunch', async () => {
  const a = await launch('en-US')
  let { app, page } = a
  try {
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-heading')).toHaveText('Settings')
    expect(await tray(app)).toContain('Open Yogurt')
    expect(await menuBar(app)).toContain('Edit')

    const picker = page.getByTestId('settings-app-language')
    await picker.selectOption('de')
    // no reload: the same page, now in German
    await expect(page.getByTestId('settings-heading')).toHaveText('Einstellungen')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.getByRole('navigation', { name: 'Arbeitsbereich' })).toBeVisible()
    await expect.poll(() => tray(app)).toContain('Yogurt öffnen')
    await expect.poll(() => menuBar(app)).toContain('Bearbeiten')

    // Arabic reads right to left: the sidebar moves to the right, text starts on the right
    await picker.selectOption('ar')
    await expect(page.getByTestId('settings-heading')).toHaveText('الإعدادات')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    const width = await page.evaluate(() => window.innerWidth)
    const side = (await page.locator('#workspace-sidebar').boundingBox())!
    expect(side.x + side.width / 2).toBeGreaterThan(width / 2)
    expect(await page.getByTestId('settings-heading').evaluate((h) => getComputedStyle(h).direction)).toBe('rtl')

    await app.close()
    ;({ app, page } = await launch('en-US', a.userData))
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-app-language')).toHaveValue('ar')

    // back to the Mac's language
    await page.getByTestId('settings-app-language').selectOption('')
    await expect(page.getByTestId('settings-heading')).toHaveText('Settings')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await expect.poll(() => tray(app)).toContain('Open Yogurt')
  } finally { await app.close() }
})
