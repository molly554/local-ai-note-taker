import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

/** askFirst: "Finish recording when the call ends" off, so the end of a call asks (autoStop.spec.ts has it on) */
async function launch(o: { askFirst?: boolean; background?: boolean } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  if (o.askFirst) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ stopWhenCallEnds: false }))
  const app = await electron.launch({ args: [main], env: { ...process.env, ...(o.background ? { YOGURT_BACKGROUND: '1' } : {}), YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
type Reading = { micApps: { bundleId: string; name: string }[]; events: unknown[] }
const signals = (app: ElectronApplication, r: Reading) =>
  app.evaluate((_e, r) => (globalThis as unknown as { __fake__: { signals(r: unknown): Promise<void> } }).__fake__.signals(r), r)
const advance = (app: ElectronApplication, ms: number) =>
  app.evaluate((_e, ms) => (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void> } }).__fake__.advance(ms), ms)
const card = async (app: ElectronApplication): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes('#prompt'))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no prompt card')
}
const event = () => {
  const start = Date.now() - 60_000
  return { id: 'ev1', title: 'Design review', start, end: start + 30 * 60_000, attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }], url: 'https://zoom.us/j/1' }
}

test('a call starts: the card offers notes, and Take notes opens the meeting recording', async () => {
  const { app, page } = await launch()
  try {
    await signals(app, { micApps: [zoom], events: [event()] })
    const p = await card(app)
    await expect(p.getByTestId('prompt-heading')).toHaveText('Take notes?')
    await expect(p.getByTestId('prompt-take-notes')).toHaveText('Start recording')
    await expect(p.getByTestId('prompt-take-notes')).not.toHaveClass(/primary/)
    await expect(p.getByTestId('prompt-title')).toHaveText('Zoom call')
    await p.getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-title')).toHaveText('Design review')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'false')
  } finally { await app.close() }
})

test('a call with no event is named after the app', async () => {
  const { app, page } = await launch()
  try {
    await signals(app, { micApps: [zoom], events: [] })
    const p = await card(app)
    await expect(p.getByTestId('prompt-title')).toHaveText('Zoom call')
    await p.getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-title')).toHaveText('Zoom call')
  } finally { await app.close() }
})

test('the compact start offer follows appearance and dismisses only after twelve idle seconds', async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(() => window.yogurt.settings.setTheme('light'))
    await signals(app, { micApps: [zoom], events: [event()] })
    const p = await card(app)
    await p.emulateMedia({ colorScheme: null })
    await expect(p.getByTestId('prompt')).toBeVisible()
    expect(await p.evaluate(() => ({width:innerWidth,height:innerHeight}))).toEqual({width:381,height:60})
    await expect(p.getByTestId('prompt')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    const heading = await p.getByTestId('prompt-heading').boundingBox(), action = await p.getByTestId('prompt-take-notes').boundingBox()
    expect(action!.x).toBeGreaterThan(heading!.x + heading!.width)
    await page.evaluate(() => window.yogurt.settings.setTheme('dark'))
    await expect(p.getByTestId('prompt')).toHaveCSS('background-color', 'rgb(41, 41, 43)')
    await p.clock.install(); await p.reload()
    await expect(p.getByTestId('prompt')).toBeVisible()
    await p.getByTestId('prompt').hover()
    await expect(p.getByTestId('prompt-countdown')).toHaveCSS('animation-play-state', 'paused')
    await p.clock.fastForward(20_000)
    expect(p.isClosed()).toBe(false)
    await p.getByTestId('prompt-take-notes').focus()
    await p.mouse.move(-10, -10)
    await p.clock.fastForward(20_000)
    expect(p.isClosed()).toBe(false)
    await p.getByTestId('prompt-take-notes').evaluate(el => (el as HTMLElement).blur())
    await p.clock.fastForward(11_900)
    expect(p.isClosed()).toBe(false)
    await p.clock.fastForward(101)
    await expect.poll(() => p.isClosed()).toBe(true)
    await signals(app, { micApps: [zoom], events: [event()] })
    expect(app.windows().filter(w => w.url().includes('#prompt'))).toHaveLength(0)
  } finally { await app.close() }
})

test('closing the card keeps it quiet for that meeting', async () => {
  const { app } = await launch()
  try {
    const ev = event()
    await signals(app, { micApps: [zoom], events: [ev] })
    await (await card(app)).getByTestId('prompt-close').click()
    await expect.poll(() => app.windows().filter((w) => w.url().includes('#prompt')).length).toBe(0)
    await signals(app, { micApps: [zoom], events: [ev] })
    await new Promise((r) => setTimeout(r, 500))
    expect(app.windows().filter((p) => p.url().includes('#prompt'))).toHaveLength(0)
  } finally { await app.close() }
})

test('a browser on the mic without a meeting link makes no card', async () => {
  const { app } = await launch()
  try {
    await signals(app, { micApps: [{ bundleId: 'com.google.Chrome', name: 'Google Chrome' }], events: [] })
    await new Promise((r) => setTimeout(r, 500))
    expect(app.windows().filter((p) => p.url().includes('#prompt'))).toHaveLength(0)
  } finally { await app.close() }
})

test('when the call ends the card asks, and Stop stops the meeting; Keep going waits', async () => {
  const { app, page } = await launch({ askFirst: true })
  try {
    await signals(app, { micApps: [zoom], events: [event()] })
    await (await card(app)).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // still on the call: nothing asked
    await advance(app, 20_000)
    await signals(app, { micApps: [zoom], events: [event()] })
    // the mic is free for 31 s
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 31_000)
    const p = await card(app)
    await expect(p.getByTestId('prompt-heading')).toHaveText('Stop recording?')
    await p.clock.install(); await p.reload()
    await expect(p.getByTestId('prompt-keep-going')).toBeVisible()
    await p.clock.fastForward(20_000)
    await expect(p.getByTestId('prompt-keep-going')).toBeVisible()
    await p.getByTestId('prompt-keep-going').click()
    await expect.poll(() => app.windows().filter((w) => w.url().includes('#prompt')).length).toBe(0)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await advance(app, 6 * 60_000)
    const q = await card(app)
    await q.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
  } finally { await app.close() }
})

test('the window is away: clicking the "Take notes?" notification starts the notes and opens them; the stop one stops', async () => {
  const { app, page } = await launch({ askFirst: true, background: true })
  const notice = () => app.evaluate(() => (globalThis as unknown as { __fake__: { notice(): unknown } }).__fake__.notice()) as Promise<{ title: string; body: string } | null>
  const clickNotice = () => app.evaluate(() => (globalThis as unknown as { __fake__: { noticeClick(): void } }).__fake__.noticeClick())
  try {
    // test runs keep the window hidden: away, as far as Yogurt can tell
    await signals(app, { micApps: [zoom], events: [event()] })
    await card(app)
    await expect.poll(notice).toEqual({ title: 'Take notes?', body: 'Design review' })
    await clickNotice()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-title')).toHaveText('Design review')
    // the card closed with it
    await expect.poll(() => app.windows().filter((w) => !w.isClosed() && w.url().includes('#prompt')).length).toBe(0)
    expect(await notice()).toBeNull()
    // the call ends: the stop card and its notification
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 31_000)
    await expect.poll(notice).toMatchObject({ title: 'Stop recording?' })
    await clickNotice()
    await expect(page.getByTestId('note-state')).not.toHaveAttribute('data-state', 'recording')
    expect(await notice()).toBeNull()
  } finally { await app.close() }
})
