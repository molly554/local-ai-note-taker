import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const locale of ['en', 'ar'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`Ask naming and navigation in ${locale}, ${theme}`, async ({}, info) => {
    const userData = mkdtempSync(join(tmpdir(), 'yogurt-ask-naming-'))
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
    const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
      ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_SYSTEM_LANGUAGES: locale,
    } })
    const ask = locale === 'ar' ? 'اسأل' : 'Ask'
    const conversations = locale === 'ar' ? 'المحادثات' : 'Conversations'
    const newConversation = locale === 'ar' ? 'محادثة جديدة' : 'New chat'
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible()
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
      await expect(page.getByTestId('nav-chat')).toHaveAccessibleName(ask)
      await page.keyboard.press('Meta+2')
      await expect(page.getByTestId('chat-page')).toBeVisible()
      await expect(page.getByTestId('workspace-heading')).toHaveText(ask)
      await expect(page.getByTestId('chat-new')).toHaveCount(0)
      await expect(page.getByTestId('chat-recent-list')).toHaveCount(0)
      await page.getByTestId('chat-recent').click()
      await expect(page.getByTestId('chat-recent-list')).toHaveAccessibleName(conversations)
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => window.yogurt.nav.current())).toBe('/chat')
      await page.screenshot({ path: info.outputPath(`ask-${locale}-${theme}-page.png`) })
      await page.keyboard.press('Meta+k')
      await page.getByTestId('search-input').fill(ask)
      await expect(page.locator('.command-row')).toHaveCount(1)
      await expect(page.getByTestId('command-chat')).toContainText(ask)
      await expect(page.getByTestId('command-chat')).toContainText('⌘2')
      await page.screenshot({ path: info.outputPath(`ask-${locale}-${theme}-commands.png`) })
      await page.getByTestId('command-chat').click()
      await expect(page.getByTestId('search')).not.toBeVisible()
      await page.keyboard.press('Meta+/')
      const row = page.getByTestId('shortcut-row').filter({ has: page.getByText(ask, { exact: true }) })
      await expect(row).toContainText('⌘2')
      await page.screenshot({ path: info.outputPath(`ask-${locale}-${theme}-shortcuts.png`) })
      await page.keyboard.press('Escape')
      await app.evaluate(() => {
        const fake = (globalThis as unknown as { __fake__: { bigMeeting(n: number): string; go(route: string): void } }).__fake__
        fake.go(`/note/${fake.bigMeeting(2)}`)
      })
      await page.getByTestId('chat-open').click()
      await expect(page.getByTestId('chat-panel')).toHaveAccessibleName(newConversation)
      await expect(page.getByTestId('chat-close')).toHaveAccessibleName(locale === 'ar' ? 'إغلاق' : 'Close')
      await page.getByTestId('chat-menu').click()
      await expect(page.getByTestId('chat-new')).toHaveText(newConversation)
      const labels = await app.evaluate(({ Menu }) => {
        const read = (menu: Electron.Menu): string[] => menu.items.flatMap(item => [item.label, ...(item.submenu ? read(item.submenu) : [])])
        const menu = Menu.getApplicationMenu()
        return menu ? read(menu) : []
      })
      expect(labels.some(label => /\bchats?\b/i.test(label))).toBe(false)
    } finally { await app.close() }
  })
}
