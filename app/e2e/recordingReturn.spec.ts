import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the header recorder returns from every other page and follows pause, rename and finish', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-recording-return-')),
  } })
  try {
    const page = await app.firstWindow()
    const link = page.getByTestId('recording-return')
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(link).toHaveCount(0)
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(o: { n: number; clean: boolean }): void } }).__fake__.manyMeetings({ n: 1, clean: true }))
    await page.reload()
    const other = (await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 })))[0].id
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.getByTestId('note-title').getByRole('button').click()
    await page.getByTestId('note-title-input').fill('Launch planning and customer feedback')
    await page.getByTestId('note-title-input').press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText('Launch planning and customer feedback')
    await expect(link).toHaveCount(0)

    const go = async (route: string) => {
      await page.evaluate((route) => window.yogurt.nav.go(route), route)
      await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe(route)
    }
    for (const route of ['/chat', '/trash', '/settings', '', `/note/${other}`]) {
      await go(route)
      await expect(link).toBeVisible()
      await expect(link.locator('time')).toHaveText(/\d+:\d{2}/)
      await expect(link).toHaveAccessibleName('Open Launch planning and customer feedback')
      await expect(page.locator('.workspace-toolbar').getByTestId('recording-return')).toBeVisible()
      expect((await link.boundingBox())!.height).toBeLessThanOrEqual(32)
      expect((await link.boundingBox())!.y).toBeLessThan(40)
      await expect(link.getByTestId('recording-return-wave')).toBeVisible()
      if (route === '/chat') await expect.poll(async () => Number(await link.getByTestId('recording-return-wave').getAttribute('data-level'))).toBeGreaterThan(0.05)
      expect(await link.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
      if (route === '') await expect(page.getByTestId('new-note')).toHaveCount(0)
      if (route.startsWith('/note/')) {
        await page.getByTestId('chat-open').click()
        const chat = (await page.getByTestId('chat-panel').boundingBox())!, button = (await link.boundingBox())!
        expect(button.y + button.height).toBeLessThan(chat.y)
        const menu = (await page.getByTestId('note-topbar').boundingBox())!
        expect(button.x + button.width).toBeLessThanOrEqual(menu.x)
        await page.getByTestId('chat-close').click()
      }
      await link.click()
      await expect(page.getByTestId('note-title')).toHaveText('Launch planning and customer feedback')
      await expect(link).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe(`/note/${id}`)
    }

    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await go('/chat')
    await expect(link).toHaveAttribute('data-paused', 'true')
    const pausedWave = await link.getByTestId('recording-return-wave').evaluate((el) => (el as HTMLCanvasElement).toDataURL())
    await page.waitForTimeout(150)
    expect(await link.getByTestId('recording-return-wave').evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(pausedWave)
    await page.reload()
    await expect(link).toHaveAttribute('data-paused', 'true')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 600))
    await expect(page.getByTestId('workspace')).toHaveClass(/sidebar-collapsed/)
    for (const direction of ['ltr', 'rtl']) {
      await page.evaluate((direction) => { document.documentElement.dir = direction }, direction)
      const bounds = (await link.boundingBox())!, composer = (await page.locator('.ask-composer').boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(720)
      expect(bounds.y).toBeLessThan(40)
      expect(bounds.x >= composer.x + composer.width || bounds.x + bounds.width <= composer.x || bounds.y + bounds.height <= composer.y).toBe(true)
    }
    await page.evaluate(() => { document.documentElement.dir = 'ltr' })
    await link.click()
    await expect(page.getByTestId('note-pause')).toBeVisible()
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Pause recording')
    await go('/settings')
    await expect(link).not.toHaveAttribute('data-paused', 'true')
    await page.evaluate((id) => window.yogurt.meetings.stop(id), id)
    await expect(link).toHaveCount(0)
    await expect(page.getByTestId('assistant-open')).toHaveCount(0)
  } finally { await app.close() }
})
