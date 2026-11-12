import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
type Prompts = { whisper: string[]; notes: string[] }

test('personal jargon: added with Enter or the suggestion, removed with × or Backspace, kept after relaunch', async () => {
  const a = await launch()
  const { page } = a
  try {
    await page.getByTestId('settings-open').click()
    const input = page.getByTestId('jargon-input')
    const chips = page.getByTestId('jargon-chip')
    await input.fill('  zentrik ')
    await expect(page.getByTestId('jargon-suggest')).toHaveText('Add "zentrik"')
    await input.press('Enter')
    await expect(chips).toHaveText(['zentrik'])
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await expect(page.getByTestId('jargon-suggest')).toHaveCount(0)

    await input.fill('PostHog')
    await page.getByTestId('jargon-suggest').click()
    await expect(chips).toHaveText(['zentrik', 'PostHog'])
    await expect(input).toBeFocused()

    // the same term again, in another case, is not added twice
    await input.fill('ZENTRIK')
    await expect(page.getByTestId('jargon-suggest')).toHaveCount(0)
    await input.press('Enter')
    await expect(chips).toHaveText(['zentrik', 'PostHog'])

    await page.getByRole('button', { name: 'Remove PostHog' }).click()
    await expect(chips).toHaveText(['zentrik'])

    await input.fill('SOC 2')
    await input.press('Enter')
    await input.fill('Kubernetes')
    await input.press('Enter')
    await expect(chips).toHaveText(['zentrik', 'SOC 2', 'Kubernetes'])
    // Backspace in the empty field takes the last one off
    await input.press('Backspace')
    await expect(chips).toHaveText(['zentrik', 'SOC 2'])
    await expect.poll(() => JSON.parse(readFileSync(join(a.userData, 'settings.json'), 'utf8')).jargon).toEqual(['zentrik', 'SOC 2'])
  } finally { await a.app.close() }

  const b = await launch(a.userData)
  try {
    await b.page.getByTestId('settings-open').click()
    await expect(b.page.getByTestId('jargon-chip')).toHaveText(['zentrik', 'SOC 2'])
  } finally { await b.app.close() }
})

test('personal jargon reaches whisper and the notes', async () => {
  const { app, page } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    const input = page.getByTestId('jargon-input')
    for (const term of ['Kubernetes', 'PostHog']) { await input.fill(term); await input.press('Enter') }
    await expect(page.getByTestId('jargon-chip')).toHaveCount(2)
    await fake(app, 'trayClick', 'new')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect.poll(async () => (await fake<Prompts>(app, 'prompts')).whisper.at(-1), { timeout: 30_000 }).toContain('We talk about Kubernetes and PostHog.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length))).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await fake<Prompts>(app, 'prompts')).notes.some((p) => p.includes('These are spelled right: Kubernetes, PostHog')), { timeout: 60_000 }).toBe(true)
  } finally { await app.close() }
})
