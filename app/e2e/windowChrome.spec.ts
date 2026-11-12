import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('glass is limited to chrome, with solid reading surfaces and a reduced-transparency fallback', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-glass-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())).toBe('#000000')
    const cdp = await page.context().newCDPSession(page)
    for (const colorScheme of ['light', 'dark'] as const) {
      // CI may have Reduce Transparency on; exercise both modes explicitly.
      await cdp.send('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-color-scheme', value: colorScheme },
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-contrast', value: 'no-preference' },
      ] })
      const chrome = await page.locator('.workspace').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity }))
      expect(chrome.background).toContain('0.85')
      expect(chrome.opacity).toBe('1')
      for (const selector of ['html', 'body', '#root', '[data-testid=app-shell]']) {
        expect(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      }
      await page.screenshot({ path: info.outputPath(`glass-${colorScheme}.png`) })
      expect(await page.locator('.workspace-content').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('52px')
      await page.getByTestId('nav-chat').click()
      // The live composer, not its fading loading copy, which can leave the page mid-read.
      await expect(page.getByTestId('chat-page-box')).toHaveCSS('background-color', /^rgb\(/)
      await page.getByTestId('nav-home').click()
      // Native captures happen only on CI; page screenshots cannot show macOS vibrancy.
      if (process.env.CI) {
        let backdrop: number | undefined
        const evidence: Record<string, unknown> = { captures: [] }
        try {
          evidence.native = await app.evaluate(({ nativeTheme, systemPreferences }) => ({
            reducedTransparency: nativeTheme.prefersReducedTransparency,
            highContrast: nativeTheme.shouldUseHighContrastColors,
            screenPermission: systemPreferences.getMediaAccessStatus('screen'),
          }))
          evidence.renderer = await page.evaluate(() => ({
            reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
            highContrast: matchMedia('(prefers-contrast: more)').matches,
          }))
          const desktop = '/System/Library/Desktop Pictures'
          const photos = readdirSync(desktop).filter(name => /\.heic$/i.test(name))
          const photo = photos.find(name => /Catalina|Big Sur|Sonoma|Monterey|Mojave|Sierra/i.test(name)) ?? photos[0]
          evidence.wallpaper = photo ?? 'not available'
          let image = ''
          if (photo) {
            const png = join(mkdtempSync(join(tmpdir(), 'yogurt-backdrop-')), 'wallpaper.png')
            execFileSync('/usr/bin/sips', ['-Z', '1200', '-s', 'format', 'png', join(desktop, photo), '--out', png])
            image = `data:image/png;base64,${readFileSync(png).toString('base64')}`
          }
          for (const [name, background] of [['dark', '#141418'], ...(image ? [['wallpaper', `url(${image}) center/cover`]] : [])]) {
            const ids = await app.evaluate(async ({ BrowserWindow, nativeTheme, screen }, { background, colorScheme }) => {
              nativeTheme.themeSource = colorScheme
              const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html'))!
              const display = screen.getPrimaryDisplay(), area = display.workArea
              main.setBounds({ x: area.x + 40, y: area.y + 40, width: Math.min(1100, area.width - 80), height: Math.min(760, area.height - 80) })
              const behind = new BrowserWindow({ ...display.bounds, frame: false, show: false })
              await behind.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;background:${background}"></body>`)}`)
              behind.showInactive(); main.show(); main.setAlwaysOnTop(true); main.moveTop()
              return { backdrop: behind.id, window: main.getMediaSourceId().split(':')[1], bounds: main.getBounds(), display: { bounds: display.bounds, scaleFactor: display.scaleFactor }, theme: nativeTheme.themeSource }
            }, { background, colorScheme })
            backdrop = ids.backdrop
            await page.waitForTimeout(250)
            ;(evidence.captures as unknown[]).push({ background: name, bounds: ids.bounds, display: ids.display, theme: ids.theme })
            execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', ids.window, info.outputPath(`glass-native-${colorScheme}-${name}.png`)])
            // Window-only capture can flatten the material. Capture the composed screen too, with a border proving
            // which backdrop was behind the window. CDP media emulation does not change macOS accessibility settings.
            const { x, y, width, height } = ids.bounds
            execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${x - 16},${y - 16},${width + 32},${height + 32}`, info.outputPath(`glass-native-${colorScheme}-${name}-screen.png`)])
            await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), backdrop)
            backdrop = undefined
          }
        } catch (error) {
          // The CI host may not grant screen capture; retain that limitation beside renderer evidence.
          evidence.error = String(error)
        } finally {
          if (backdrop !== undefined) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), backdrop)
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html'))?.setAlwaysOnTop(false))
          writeFileSync(info.outputPath(`glass-native-${colorScheme}.txt`), JSON.stringify(evidence, null, 2))
        }
      }
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    const solid = await page.locator('.workspace').evaluate(el => getComputedStyle(el).backgroundColor)
    expect(solid).toMatch(/^rgb\(/)
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] })
    expect(await page.locator('.workspace').evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/)
    await cdp.detach()
    await page.getByTestId('sidebar-collapse').click()
    await expect(page.getByTestId('sidebar-expand')).toBeVisible()
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings')).toBeVisible()
  } finally { await app.close() }
})
