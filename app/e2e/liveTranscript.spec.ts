import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = (app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const)
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
const start = async (app: ElectronApplication, page: Page) => {
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
}

/** every state the transcript is drawn in, per side: the final lines' words and the live words, in order */
const record = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __snaps: Array<Record<'me' | 'them', string>> }
  w.__snaps = []
  const take = () => {
    const out: Record<'me' | 'them', string[]> = { me: [], them: [] }
    for (const el of Array.from(document.querySelectorAll('[data-testid="transcript-bubble"] [data-testid="transcript-text"], [data-testid="transcript-bubble"] .live-word')) as HTMLElement[]) {
      const track = (el.closest('[data-testid="transcript-bubble"]') as HTMLElement).dataset.track as 'me' | 'them'
      out[track].push(el.textContent ?? '')
    }
    const s = { me: out.me.join(' '), them: out.them.join(' ') }
    const last = w.__snaps.at(-1)
    if (!last || last.me !== s.me || last.them !== s.them) w.__snaps.push(s)
  }
  new MutationObserver(take).observe(document.body, { subtree: true, childList: true, characterData: true })
})
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').split(/\s+/).filter(Boolean)

/** no run of four words twice on a side, and every word once shown stays, in the same order, as more comes */
async function checkSteady(page: Page) {
  const snaps = await page.evaluate(() => (window as unknown as { __snaps: Array<Record<'me' | 'them', string>> }).__snaps)
  expect(snaps.length).toBeGreaterThan(5)
  for (const track of ['me', 'them'] as const) {
    let prev: string[] = []
    for (const snap of snaps) {
      const ws = words(snap[track])
      const grams = ws.slice(3).map((_, i) => ws.slice(i, i + 4).join(' '))
      expect(new Set(grams).size, `${track} shows words twice: ${snap[track]}`).toBe(grams.length)
      expect(ws.slice(0, prev.length), `${track} lost words: "${prev.join(' ')}" then "${ws.join(' ')}"`).toEqual(prev)
      prev = ws
    }
  }
}

for (const speech of [false, true]) {
  test(`live words ${speech ? "from Apple's speech" : 'from whisper'} never show twice and never vanish once shown`, async () => {
    const { app, page } = await launch(speech ? { YOGURT_FAKE_SPEECH: '1' } : {})
    try {
      await record(page)
      await start(app, page)
      await expect(page.getByTestId('transcript-partial').first()).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
      await page.waitForTimeout(500)
      await checkSteady(page)
    } finally { await app.close() }
  })
}

test('the live transcript reads like a conversation: your bubbles at the end, theirs at the start, words not final yet lighter with dots', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SPEECH: '1' })
  try {
    await start(app, page)
    const list = page.getByTestId('transcript')
    const live = page.getByTestId('transcript-partial').first()
    await expect(live).toBeVisible({ timeout: 15_000 })
    await expect(live.locator('.live-dots')).toHaveCount(1)
    const mine = page.getByTestId('transcript-bubble').filter({ hasText: 'Can we go over the launch plan' })
    const theirs = page.getByTestId('transcript-bubble').filter({ hasText: 'The site goes live on Tuesday' })
    await expect(theirs.getByTestId('transcript-line')).toBeVisible({ timeout: 30_000 })
    const box = (await list.boundingBox())!, m = (await mine.boundingBox())!, th = (await theirs.boundingBox())!
    const inset = await list.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineStart))
    expect(box.x + box.width - (m.x + m.width)).toBeCloseTo(inset, 0)
    expect(th.x - box.x).toBeCloseTo(inset, 0)
    // their name heads their turn; the mic's side needs no label to be told apart
    await expect(page.getByTestId('transcript-turn').filter({ has: theirs }).getByTestId('transcript-who')).toBeVisible()
    await expect(page.getByTestId('transcript-turn').filter({ has: mine }).locator('p.sr-only')).toHaveText(/^You/)
    // live words are lighter than settled ones
    await expect(page.getByTestId('transcript-partial').first()).toBeVisible({ timeout: 15_000 })
    const colors = await page.evaluate(() => ({
      live: getComputedStyle(document.querySelector('.live-words')!).color,
      final: getComputedStyle(document.querySelector('[data-testid="transcript-bubble"] [data-testid="transcript-text"]')!).color,
    }))
    expect(colors.live).not.toBe(colors.final)
    // right to left, the sides swap
    await page.evaluate(() => { document.documentElement.dir = 'rtl' })
    const r = (await mine.boundingBox())!
    expect(r.x - box.x).toBeLessThan(30)
  } finally { await app.close() }
})

test('with reduced motion, live words show at once and the dots hold still', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SPEECH: '1' })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(app, page)
    const live = page.getByTestId('transcript-partial').first()
    await expect(live).toBeVisible({ timeout: 15_000 })
    expect(await live.evaluate((el) => [getComputedStyle(el.querySelector('.live-word')!).animationName, getComputedStyle(el.querySelector('.live-dots i')!).animationName])).toEqual(['none', 'none'])
  } finally { await app.close() }
})

test('unfinished words survive tab changes, page navigation and renderer reload without repeating saved lines', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_SPEECH: '1' })
  try {
    await start(app, page)
    const live = page.getByTestId('transcript-partial').first()
    await expect(live).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    const text = (await live.textContent())!.trim()
    expect(text.length).toBeGreaterThan(3)
    await page.getByTestId('note-notes-tab').click()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(live).toHaveText(text)
    await page.getByTestId('settings-open').click()
    await page.getByTestId('recording-return').click()
    await expect(live).toHaveText(text)
    await page.reload()
    await page.getByTestId('note-transcript-toggle').click()
    await expect(live).toHaveText(text)
    await page.getByTestId('note-pause').click()
    // The pause can cut the fixture sentence: only the words recorded before it must settle into a saved line.
    await expect(page.getByTestId('transcript-line').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
    const said = await page.getByTestId('transcript').textContent()
    expect(said!.split(text)).toHaveLength(2)
  } finally { await app.close() }
})
