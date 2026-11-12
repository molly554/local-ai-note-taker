import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(permissions = false, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-polish-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ welcomed: true, introSeen: true }))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: dir,
    ...(permissions ? { YOGURT_FAKE_PERMISSIONS: 'unknown' } : {}),
    ...env,
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, dir }
}
const fake = (app: ElectronApplication, fn: string, arg?: unknown) => app.evaluate((_e, [fn, arg]) =>
  (globalThis as unknown as { __fake__: Record<string, (arg: unknown) => unknown> }).__fake__[fn as string](arg), [fn, arg])

test('calendar selection persists, filters matching copies, and keeps separate time slots', async () => {
  const { app, page, dir } = await launch()
  try {
    const at = new Date(); at.setHours(10, 0, 0, 0)
    const row = { id: 'work-copy', externalId: 'one-event', title: 'Lap Swim', calendarId: 'work', calendar: 'Work', calendarSource: 'Example account', start: at.toISOString(), end: new Date(+at + 3600000).toISOString() }
    await fake(app, 'calendarEvents', [row, { ...row, id: 'personal-copy', calendarId: 'personal', calendar: 'Personal' }, { ...row, id: 'next-slot', start: new Date(+at + 7200000).toISOString(), end: new Date(+at + 10800000).toISOString() }])
    await page.reload()
    await expect(page.getByTestId('event')).toHaveCount(2)
    await page.getByTestId('settings-open').click()
    const calendars = page.getByTestId('calendar-settings-toggle')
    await expect(calendars).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('calendar-choice').first()).not.toBeVisible()
    await calendars.click()
    await expect(page.getByTestId('calendar-choice')).toHaveCount(2)
    await page.getByTestId('calendar-choice').filter({ hasText: 'Work' }).getByRole('checkbox').uncheck()
    await expect.poll(() => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hiddenCalendarIds).toEqual(['work'])
    await calendars.click()
    await calendars.press('Enter')
    await expect(page.getByTestId('calendar-choice').filter({ hasText: 'Work' }).getByRole('checkbox')).not.toBeChecked()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('event')).toHaveCount(1)
    await page.keyboard.press('Meta+[')
    await expect(calendars).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('event-details').click()
    await expect(page.getByTestId('event-details-content')).toContainText('Personal')
    await page.reload()
    await expect(page.getByTestId('event')).toHaveCount(1)
  } finally { await app.close() }
})

test('setup lives in the sidebar, opens an accessible checklist, and keeps permission prompts', async () => {
  const { app, page } = await launch(true)
  try {
    await expect(page.getByTestId('home').getByTestId('finish-setup')).toHaveCount(0)
    await expect(page.getByTestId('recording-setup-hint')).toHaveCount(0)
    await page.getByTestId('finish-setup-open').click()
    await expect(page.getByTestId('finish-setup-item')).toHaveCount(4)
    await page.getByTestId('finish-setup-item').filter({ hasText: 'Microphone' }).getByTestId('finish-setup-fix').click()
    await expect(page.getByTestId('finish-setup-item')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('finish-setup-open')).toBeFocused()
    await page.getByTestId('nav-chat').click()
    await expect(page.getByTestId('finish-setup-open')).toBeVisible()
  } finally { await app.close() }
})

test('denying both recording inputs keeps the microphone first, then fixes call audio without claiming either is recording', async () => {
  const { app, page } = await launch(true, { YOGURT_FAKE_ANSWER: 'deny' })
  try {
    await page.getByTestId('new-note').or(page.getByTestId('past-empty').getByRole('button')).first().click()
    await expect(page.getByTestId('rec-hint')).toContainText("can't hear your microphone or the call")
    await expect(page.getByTestId('rec-hint')).not.toContainText('Only your mic')
    await expect(page.getByTestId('rec-hint-fix')).toHaveAttribute('data-kind', 'mic')
    await page.getByTestId('rec-hint-fix').click()
    await expect(page.getByTestId('permission-guide')).toBeVisible()
    await expect(page.getByTestId('settings-guide').locator('ol')).toHaveCount(0)
    await expect(page.getByTestId('settings-guide-waiting').locator('svg')).toHaveCount(0)
    await fake(app, 'permission', ['mic', 'granted'])
    await expect(page.getByTestId('permission-guide')).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByTestId('rec-hint-fix')).toHaveAttribute('data-kind', 'systemAudio')
    await page.getByTestId('rec-hint-fix').click()
    await fake(app, 'permission', ['systemAudio', 'granted'])
    await expect(page.getByTestId('permission-guide')).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByTestId('rec-hint')).toContainText('start again')
    await expect(page.getByTestId('rec-hint-fix')).toHaveCount(0)
  } finally { await app.close() }
})

test('Ask shows progress through the first-token gap, then an attached copy action', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake(app, 'bigMeeting', 10) as string
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-input')).toBeEnabled()
    const view = await page.evaluate(async id => window.yogurt.conversations.get(await window.yogurt.conversations.current([{ kind: 'meeting', id }])), id)
    const send = (answer: string, status: string) => app.evaluate(({ BrowserWindow }, v) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('conversations:changed', v)
    }, { ...view, turns: [{ id: 99, question: 'What was decided?', answer, status, sources: [], createdAt: Date.now() }], waitsForMeeting: false, waitsForModel: false })
    await send('', 'answering')
    await expect(page.locator('.chat-progress')).toBeVisible()
    await expect(page.locator('.ask-conversation')).toHaveAttribute('aria-busy', 'true')
    await send('Keep the first release focused.', 'answering')
    await expect(page.locator('.chat-progress')).toHaveCount(0)
    await expect(page.getByTestId('chat-answer')).toBeVisible()
    await send('Keep the first release focused.', 'done')
    await expect(page.getByTestId('chat-copy-answer')).toHaveText('Copy')
    await page.getByTestId('chat-copy-answer').click()
    await expect(page.getByTestId('chat-copy-answer')).toHaveText('Copied')
  } finally { await app.close() }
})
