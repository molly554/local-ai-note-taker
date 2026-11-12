import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
const FULL_ANSWER = 'The launch plan, in short:\nThe site goes live on Tuesday.\nThe email goes out on Wednesday morning.'

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
/** the answer's text read in the very frame its turn leaves `answering` (no retrying until it catches up) */
const answerWhenSettled = (page: Page) => page.waitForFunction(() => {
  const turn = document.querySelector<HTMLElement>('[data-testid="chat-turn"]')
  if (!turn || turn.dataset.status === 'answering' || turn.dataset.status === 'waiting') return false
  return { status: turn.dataset.status, text: turn.querySelector<HTMLElement>('[data-testid="chat-answer"]')?.innerText ?? '' }
}, undefined, { timeout: 20_000, polling: 'raf' }).then((h) => h.jsonValue() as Promise<{ status?: string; text: string }>)
const tidy = (s: string) => s.replace(/\n+/g, '\n').trim()
/** the style of the dot after the last word: on the last block, inside the last list item when it ends in a list */
const caret = (box: ReturnType<Page['getByTestId']>) => box.evaluate((el) => {
  let at: Element = el.lastElementChild ?? el
  while (/^(UL|OL)$/.test(at.tagName)) at = at.lastElementChild?.lastElementChild ?? at
  const s = getComputedStyle(at, '::after')
  return { content: s.content, animation: s.animationName }
})

test('a fast model is never held back: the answer is all there the moment it is done', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '2' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 30)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    const settled = await answerWhenSettled(page)
    expect(settled.status).toBe('done')
    expect(tidy(settled.text)).toBe(FULL_ANSWER)
    await expect(page.getByTestId('chat-answer')).not.toHaveClass(/stream-caret/)
  } finally { await app.close() }
})

test('while an answer is written it only ever shows the start of the answer; a stop shows everything received at once', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '120' })
  try {
    const id = await fake<string>(app, 'bigMeeting', 30)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    const answer = page.getByTestId('chat-answer')
    await expect(answer).toHaveClass(/stream-caret/, { timeout: 10_000 })
    // the pulsing dot after the last word
    expect((await caret(answer)).content).toBe('"●"')
    for (let i = 0; i < 6; i++) {
      const shown = tidy(await answer.innerText())
      expect(FULL_ANSWER.replace(/\n/g, ' ').startsWith(shown.replace(/\n/g, ' ').replace(/●/g, '').trim()), `Shown prefix: ${JSON.stringify(shown)}`).toBe(true)
      await page.waitForTimeout(90)
    }
    await page.getByTestId('chat-stop').click()
    const settled = await answerWhenSettled(page)
    expect(settled.status).toBe('stopped')
    // what was saved is what was on screen when it stopped
    await page.reload()
    await page.getByTestId('chat-open').click()
    await expect(page.getByTestId('chat-turn')).toHaveAttribute('data-status', 'stopped')
    expect(tidy(await page.getByTestId('chat-answer').innerText())).toBe(tidy(settled.text))
  } finally { await app.close() }
})

test('with reduced motion an answer shows each piece as it arrives, with no dot pulsing', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '120' })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const id = await fake<string>(app, 'bigMeeting', 30)
    await fake(app, 'go', `/note/${id}`)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('When does the site go live?')
    await page.getByTestId('chat-input').press('Enter')
    const answer = page.getByTestId('chat-answer')
    await expect(answer).toHaveClass(/stream-caret/, { timeout: 10_000 })
    expect(await caret(answer)).toEqual({ content: '"●"', animation: 'none' })
    // each piece the model sends is a whole word with its space: never a word cut short on screen
    for (let i = 0; i < 5; i++) {
      const words = (await answer.innerText()).replace(/●/g, '').trim().split(/\s+/).filter(Boolean)
      const all = FULL_ANSWER.split(/\s+/)
      expect(words.every((w, j) => w === all[j].replace(/\*/g, ''))).toBe(true)
      await page.waitForTimeout(70)
    }
    expect(tidy((await answerWhenSettled(page)).text)).toBe(FULL_ANSWER)
  } finally { await app.close() }
})

test('the summary unrolls while it is written and ends with exactly the saved notes', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_LLM_MS: '30' })
  try {
    await fake(app, 'signals', { micApps: [], events: [] })
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    await page.getByTestId('note-stop').click()
    const enhanced = page.getByTestId('note-enhanced')
    await expect(enhanced).toHaveAttribute('data-status', 'writing', { timeout: 30_000 })
    const editor = page.getByTestId('note-enhanced-editor')
    expect((await caret(editor)).content).toBe('"●"')
    // the text on screen in the frame the notes are saved
    const final = await page.waitForFunction(() => {
      const box = document.querySelector<HTMLElement>('[data-testid="note-enhanced"]')
      return box?.dataset.status === 'done' && document.querySelector<HTMLElement>('[data-testid="note-enhanced-editor"]')!.innerText
    }, undefined, { timeout: 30_000, polling: 'raf' }).then((h) => h.jsonValue() as Promise<string>)
    expect(final).toContain('Share the launch plan with the team.')
    await page.reload()
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'done')
    expect(tidy(await page.getByTestId('note-enhanced-editor').innerText())).toBe(tidy(final))
  } finally { await app.close() }
})
