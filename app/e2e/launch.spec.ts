import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

test('@everywhere opens a window called Yogurt with the app shell', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page).toHaveTitle('Yogurt')
    // the bridge is there, and knows it's a test run
    expect(await page.evaluate(() => window.yogurt.fake)).toBe(true)
  } finally { await app.close() }
})

test('@everywhere shows the Yogurt logo', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('img', { name: 'Yogurt', exact: true })).toBeVisible()
  } finally { await app.close() }
})
