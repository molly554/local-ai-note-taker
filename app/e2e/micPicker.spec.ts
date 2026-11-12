import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

test('the mic picker lists the mics, switches the live recording, remembers the choice and falls back to Auto', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-mic-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    const chip = page.getByTestId('rec-mic-chip')
    await expect(page.getByTestId('rec-mic')).toHaveText('MacBook Pro Microphone')

    // Auto first, with the Mac's own mic under it, then every mic; the one in use is checked
    await chip.click()
    const menu = page.getByTestId('mic-menu')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('mic-auto')).toContainText('Auto')
    await expect(page.getByTestId('mic-auto-name')).toHaveText('MacBook Pro Microphone')
    await expect(page.getByTestId('mic-auto-info')).toHaveAttribute('title', 'Uses the microphone your Mac is set to')
    await expect(page.getByTestId('mic-option')).toHaveText(['MacBook Pro Microphone', 'Yeti Stereo Microphone', 'iPhone Microphone'])
    await expect(page.getByTestId('mic-auto')).toHaveAttribute('aria-checked', 'true')

    // choosing one switches the recording: the recorder says it uses it, and the meeting goes on in the same note
    const lines = async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length
    await page.getByTestId('mic-option').filter({ hasText: 'Yeti' }).click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('rec-mic')).toHaveText('Yeti Stereo Microphone')
    await expect.poll(async () => (await page.evaluate(() => window.yogurt.audio.mics())).choice).toBe('fake-yeti')
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).mic).toBe('fake-yeti')
    const before = await lines()
    await expect.poll(lines, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect((await page.evaluate(() => window.yogurt.nav.current()))).toBe(`/note/${id}`)
    await chip.click()
    await expect(page.getByTestId('mic-option').filter({ hasText: 'Yeti' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('mic-auto')).toHaveAttribute('aria-checked', 'false')

    // a mic plugged in while the menu is open shows up
    await fake(app, 'micDevices', [
      { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', default: true },
      { uid: 'fake-yeti', name: 'Yeti Stereo Microphone', default: false },
      { uid: 'fake-iphone', name: 'iPhone Microphone', default: false },
      { uid: 'fake-webcam', name: 'HD Pro Webcam C920', default: false },
    ])
    await expect(page.getByTestId('mic-option')).toHaveCount(4)
    // Auto again: the Mac's own mic
    await page.getByTestId('mic-auto').click()
    await expect(page.getByTestId('rec-mic')).toHaveText('MacBook Pro Microphone')
    await expect.poll(async () => (await page.evaluate(() => window.yogurt.audio.mics())).choice).toBeNull()
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).mic).toBeUndefined()

    // the chosen mic is unplugged mid-meeting: Auto takes over, with a plain note, and recording goes on
    await chip.click()
    await page.getByTestId('mic-option').filter({ hasText: 'Webcam' }).click()
    await expect(page.getByTestId('rec-mic')).toHaveText('HD Pro Webcam C920')
    await fake(app, 'micDevices', null)
    await expect(page.getByTestId('rec-mic-note')).toHaveText("HD Pro Webcam C920 isn't available anymore. Recording continues with Auto.")
    await expect(page.getByTestId('rec-mic')).toHaveText('MacBook Pro Microphone')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await chip.click()
    await expect(page.getByTestId('mic-auto')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mic-menu')).toHaveCount(0)

    // the choice is remembered for the next recording
    await chip.click()
    await page.getByTestId('mic-option').filter({ hasText: 'iPhone' }).click()
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await page.getByTestId('nav-home').click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('rec-mic')).toHaveText('iPhone Microphone')
    await expect.poll(async () => (await page.evaluate(() => window.yogurt.audio.mics())).choice).toBe('fake-iphone')
    await page.getByTestId('note-stop').click()

    // and if it isn't plugged in next time, the recording uses Auto
    await fake(app, 'micDevices', [{ uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', default: true }])
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await page.getByTestId('nav-home').click()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('rec-mic')).toHaveText('MacBook Pro Microphone')
    await expect.poll(async () => (await page.evaluate(() => window.yogurt.audio.mics())).choice).toBeNull()
    await expect(page.getByTestId('rec-mic-note')).toHaveCount(0)
  } finally { await app.close() }
})
