import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }

async function launch(o: { settings?: object; env?: Record<string, string> } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  if (o.settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(o.settings))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, ...o.env } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
type Reading = { micApps: { bundleId: string; name: string }[]; events: unknown[]; runningApps?: string[] }
const fake = <T = unknown>(app: ElectronApplication, fn: string, arg?: unknown) =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const signals = (app: ElectronApplication, r: Reading) => fake(app, 'signals', r)
const advance = (app: ElectronApplication, ms: number) => fake(app, 'advance', ms)
const notice = (app: ElectronApplication) => fake<{ title: string; body: string } | null>(app, 'notice')
const cards = (app: ElectronApplication) => app.windows().filter((w) => !w.isClosed() && w.url().includes('#prompt')).length
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => !p.isClosed() && p.url().endsWith(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
const card = (app: ElectronApplication) => windowOf(app, '#prompt')
const event = () => {
  const start = Date.now() - 60_000
  return { id: 'ev1', title: 'Design review', start, end: start + 30 * 60_000, attendees: [], url: 'https://zoom.us/j/1' }
}
/** a Zoom call starts and Take notes is pressed */
async function callAndRecord(app: ElectronApplication, page: Page) {
  await signals(app, { micApps: [zoom], events: [event()] })
  await (await card(app)).getByTestId('prompt-take-notes').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
}

test('the call ends: after the grace the recording stops by itself, with no question, and says so', async () => {
  const { app, page } = await launch({ env: { YOGURT_BACKGROUND: '1' } })
  try {
    await callAndRecord(app, page)
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 9_000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await advance(app, 2_000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    // nothing asked
    expect(cards(app)).toBe(0)
    // the window is away in test runs: the notification says it, and clicking it opens the note to resume
    await expect.poll(() => notice(app)).toEqual({ title: 'Call ended. Recording stopped.', body: 'Design review' })
    await expect.poll(async () => (await fake<{ view: { kind: string; callEnded?: boolean } | null }>(app, 'widget')).view).toMatchObject({ kind: 'captured', callEnded: true })
    // Automatic stops use the existing system notice, never a finished recorder or a second notice.
    await expect.poll(() => fake(app, 'widget')).toMatchObject({ visible: false, bounds: null, notice: null })
    await fake(app, 'noticeClick')
    await expect(page.getByTestId('note-resume')).toBeVisible()
  } finally { await app.close() }
})

test('a blip shorter than the grace does nothing', async () => {
  const { app, page } = await launch()
  try {
    await callAndRecord(app, page)
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 6_000)
    await signals(app, { micApps: [zoom], events: [event()] })
    await advance(app, 6_000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(cards(app)).toBe(0)
  } finally { await app.close() }
})

test('the grace can be shortened in fake mode', async () => {
  const { app, page } = await launch({ env: { YOGURT_FAKE_CALL_GONE_MS: '1000' } })
  try {
    await callAndRecord(app, page)
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 1_500)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
  } finally { await app.close() }
})

test('switched off in Settings: it asks as before', async () => {
  const { app, page, userData } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('autostop-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).stopWhenCallEnds).toBe(false)
    await callAndRecord(app, page)
    await signals(app, { micApps: [], events: [event()] })
    await advance(app, 31_000)
    await expect((await card(app)).getByTestId('prompt-heading')).toHaveText('Stop recording?')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  } finally { await app.close() }
})

test('a recording started by hand with no call is never stopped by itself', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'trayClick', 'new')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await signals(app, { micApps: [], events: [] })
    await advance(app, 60_000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(cards(app)).toBe(0)
  } finally { await app.close() }
})


for (const call of [
  { name: 'Zoom', bundleId: 'us.zoom.CptHost', owner: 'us.zoom.xos' },
  { name: 'FaceTime', bundleId: 'com.apple.avconferenced', owner: 'com.apple.FaceTime' },
]) test(`an agenda recording binds ${call.name} when it arrives later, then stops when its mic goes away`, async () => {
  const { app, page, userData } = await launch()
  try {
    const now = await page.evaluate(() => { const day = new Date(); day.setHours(12, 0, 0, 0); return +day })
    await page.clock.setFixedTime(now)
    await app.evaluate(async (_e, at) => {
      await (globalThis as unknown as { __fake__: { advance(ms: number): Promise<void> } }).__fake__.advance(at - Date.now())
    }, now)
    const e = { ...event(), start: now - 60000, end: now + 1800000 }
    await fake(app, 'calendarEvents', [{ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() }])
    await signals(app, { micApps: [], events: [e] })
    await page.reload()
    await page.getByTestId('event-start').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await page.evaluate(() => window.yogurt.nav.current().then(route => route.slice('/note/'.length)))
    const bound = () => page.evaluate(id => window.yogurt.meetings.get(id).then(m => m?.app), id)
    expect(await bound()).toBeNull()
    await advance(app, 10000)
    // Core Audio can report the audio helper instead of its owning app.
    await signals(app, { micApps: [{ bundleId: call.bundleId, name: 'Audio helper' }], events: [e], runningApps: [call.owner] })
    await expect.poll(bound).toBe(call.name)
    await signals(app, { micApps: [], events: [e] })
    await advance(app, 9000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await advance(app, 2000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    const logs = () => readFileSync(join(userData, 'logs/main.log'), 'utf8')
    await expect.poll(logs).toContain(`CALL bind meeting=${id} app=${call.name} via=mic`)
    await expect.poll(logs).toContain(`CALL gone meeting=${id} app=${call.name} idle_ms=`)
  } finally { await app.close() }
})


test('FaceTime audio/video and handed-off calls offer a card for the shared mic daemon only with FaceTime running', async () => {
  const { app, page, userData } = await launch()
  try {
    const micApps = [{ bundleId: 'com.apple.avconferenced', name: 'avconferenced' }]
    await signals(app, { micApps, events: [], runningApps: [] })
    expect(cards(app)).toBe(0)
    await signals(app, { micApps, events: [], runningApps: ['com.apple.FaceTime'] })
    await (await card(app)).getByTestId('prompt-take-notes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await page.evaluate(() => window.yogurt.nav.current().then(route => route.slice('/note/'.length)))
    expect(await page.evaluate(id => window.yogurt.meetings.get(id).then(m => m?.app), id)).toBe('FaceTime')
    await signals(app, { micApps, events: [], runningApps: ['com.apple.FaceTime'] })
    await signals(app, { micApps: [], events: [], runningApps: ['com.apple.FaceTime'] })
    await advance(app, 11000)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    const logs = readFileSync(join(userData, 'logs/main.log'), 'utf8')
    expect(logs).toContain('CALL offer app=FaceTime mic=com.apple.avconferenced')
    expect(logs).toContain(`CALL gone meeting=${id} app=FaceTime idle_ms=`)
  } finally { await app.close() }
})
