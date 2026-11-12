import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @everywhere: the setup speed check of Windows and Linux (fake timings, YOGURT_FAKE_RTF). The Mac CI tries them through YOGURT_FAKE_PLATFORM.
const main = join(import.meta.dirname, '../out/main/index.js')
const launch = (env: Record<string, string>) => {
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  return { profile, app: electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile, ...env } }) }
}
const stored = (profile: string) => JSON.parse(readFileSync(join(profile, 'speech-speed.json'), 'utf8'))

const words: Record<string, string> = {
  win32: "Yogurt runs entirely on your computer, and this one can't write down a meeting as fast as people talk. Updating your graphics driver may help. Otherwise it needs a faster processor, or graphics it can use.",
  linux: "Yogurt runs entirely on your computer, and this one can't write down a meeting as fast as people talk. Installing the driver for your graphics card may help. Otherwise it needs a faster processor, or graphics it can use.",
}

for (const platform of ['win32', 'linux']) {
  test(`@everywhere on ${platform}: a computer that can't keep up is told so plainly, and nothing records; Try again times it again`, async () => {
    const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_RTF: '2' })
    const app = await launching
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('setup-error')).toHaveText(words[platform], { timeout: 15_000 })
      await expect(page.getByTestId('home')).toHaveCount(0)
      expect(stored(profile)).toMatchObject({ model: null, rtf: { 'whisper-large-v3-turbo-q5_0': 2, 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 2, 'whisper-tiny-q5_1': 2 } })
      const at = stored(profile).at
      await page.getByTestId('setup-retry').click()
      await expect.poll(() => stored(profile).at, { timeout: 15_000 }).not.toBe(at)
      await expect(page.getByTestId('setup-error')).toHaveText(words[platform])
    } finally { await app.close() }
  })

  test(`@everywhere on ${platform}: the best speech model that keeps up is kept, and recording is ready`, async () => {
    const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: platform, YOGURT_FAKE_RTF: 'whisper-large-v3-turbo-q5_0=0.9,whisper-small-q5_1=0.7' })
    const app = await launching
    try {
      const page = await app.firstWindow()
      await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
      expect(stored(profile)).toMatchObject({ model: 'whisper-base-q5_1', rtf: { 'whisper-large-v3-turbo-q5_0': 0.9, 'whisper-small-q5_1': 0.7, 'whisper-base-q5_1': 0.1 } })
    } finally { await app.close() }
  })
}

test('@everywhere a Mac never times its speech model: turbo as always, even when every time would be too slow', async () => {
  const { app: launching, profile } = launch({ YOGURT_FAKE_PLATFORM: 'darwin', YOGURT_FAKE_RTF: '2' })
  const app = await launching
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(profile, 'speech-speed.json'))).toBe(false)
    expect(existsSync(join(profile, 'models', 'asr', 'ggml-large-v3-turbo-q5_0.bin'))).toBe(true)
  } finally { await app.close() }
})
