import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
type Snap = { visible: boolean; view: { kind: string; note: { text: string } | null; crashed: boolean } | null; notice: { title: string; body: string; meetingId: string } | null; bounds: { x: number; y: number; width: number; height: number } | null; workArea: { x: number; y: number; width: number; height: number } }

async function launch(settings?: object) {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  if (settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings))
  // These tests control foreground/background explicitly instead of competing for native focus.
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  // the config's actionTimeout never reaches Electron's windows: without this a click that can't land waits out the
  // whole test, and the stuck app then holds up the worker's teardown too (how "pause says Paused" failed once)
  app.context().setDefaultTimeout(15_000)
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}
const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>
const snap = (app: ElectronApplication) => fake<Snap>(app, 'widget')
const windowOf = async (app: ElectronApplication, hash: string): Promise<Page> => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes(hash))
    if (w) return w
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${hash} window`)
}
/** a call starts and the card's Take notes is pressed: the meeting is recording */
async function record(app: ElectronApplication, page: Page) {
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  const widget = await windowOf(app, '#widget')
  await expect(widget.getByTestId('widget')).toBeVisible()
  return widget
}

test('the widget is a compact horizontal recorder with one live wave and no external shadow', async () => {
  const { app, page } = await launch()
  try {
    expect((await snap(app)).visible).toBe(false)
    const w = await record(app, page)
    await expect(w.getByTestId('widget')).toHaveAttribute('data-kind', 'recording')
    const s = await snap(app)
    expect(s.visible).toBe(true)
    const style = await w.getByTestId('widget').evaluate((el) => ({ shadow: getComputedStyle(el).boxShadow, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    // The snapshot keeps the resting pill bounds.
    expect(style.height).toBe(42)
    expect(style.width).toBeLessThan(127)
    expect(s.bounds).toMatchObject({ width: Math.ceil(style.width), height: 42 })
    expect(style.shadow).toBe('none')
    // one meter, moved by the microphone of the fake call
    await expect(w.getByTestId('widget-wave')).toHaveCount(1)
    await expect.poll(async () => Number(await w.getByTestId('widget-wave').getAttribute('data-level')), { timeout: 15_000 }).toBeGreaterThan(0.05)
    await expect(w.getByTestId('widget-time')).not.toHaveText('0:00')
    // Recording controls belong in the meeting; the entire pill opens that note.
    await expect(w.getByTestId('widget-pause')).toHaveCount(0)
    await expect(w.getByTestId('widget-stop')).toHaveCount(0)
    await expect(w.getByTestId('widget-resume')).toHaveCount(0)
    await expect(w.getByTestId('logo')).toBeVisible()
  } finally { await app.close() }
})

test('Finish closes the floating recorder and prepares a completion notification', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    await fake(app, 'warn', 'no-system-audio')
    const preview = await windowOf(app, '#widget')
    await expect(preview.getByTestId('widget-note')).toBeVisible()
    const before = await fake<{ presented: number }>(app, 'main')
    await page.getByTestId('note-stop').click()
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(before.presented)
    await expect.poll(() => w.isClosed()).toBe(true)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    expect((await snap(app)).visible).toBe(false)
    expect((await snap(app)).bounds).toBeNull()
    expect((await snap(app)).notice?.title).toBe('Meeting captured')
  } finally { await app.close() }
})

test('Pause hides the recorder and preview; Resume in the meeting restores its placed position', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const bounds = (await snap(app)).bounds!
    const box = (await w.getByTestId('widget').boundingBox())!
    await w.mouse.move(box.x + 50, box.y + 20)
    const preview = await windowOf(app, '#widget')
    await expect(w.getByTestId('widget')).toHaveAttribute('data-open', 'true')
    await expect(preview.getByTestId('widget-preview')).toBeVisible()
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    await expect(w.getByTestId('widget')).toHaveCount(0)
    await expect(preview.getByTestId('widget')).toHaveCount(0)
    expect((await snap(app)).visible).toBe(false)
    expect((await snap(app)).notice).toBeNull()
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'false')
    await expect(w.getByTestId('widget-wave')).toBeVisible()
    expect((await snap(app)).visible).toBe(true)
    expect((await snap(app)).bounds).toEqual(bounds)
    await page.getByTestId('note-pause').click()
    await expect(w.getByTestId('widget')).toHaveCount(0)
    await page.getByTestId('note-stop').click()
    await expect.poll(() => w.isClosed()).toBe(true)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
  } finally { await app.close() }
})

test('a failed Resume stays paused and hidden until a successful retry in the meeting', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    await page.getByTestId('note-pause').click()
    await app.evaluate(({ ipcMain }) => {
      type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers.get('meetings:set-paused')!
      ipcMain.removeHandler('meetings:set-paused')
      let fails = true
      ipcMain.handle('meetings:set-paused', (event, ...args) => {
        if (fails) { fails = false; return false }
        return original(event, ...args)
      })
    })
    const bounds = (await snap(app)).bounds!
    await page.getByTestId('note-pause').click()
    await expect(page.getByText("Couldn't resume the recording. Try again.", { exact: true })).toBeVisible()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    await expect(w.getByTestId('widget')).toHaveCount(0)
    expect((await snap(app)).visible).toBe(false)
    expect((await snap(app)).bounds).toEqual(bounds)
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'false')
    await expect(w.getByTestId('widget-wave')).toBeVisible()
    expect((await snap(app)).visible).toBe(true)
    await page.getByTestId('note-stop').click()
  } finally { await app.close() }
})

test('clicking the widget opens the note', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const meeting = (await fake<{ route: string }>(app, 'main')).route
    await fake(app, 'go', '')
    await expect(page.getByTestId('home')).toBeVisible()
    const before = await fake<{ presented: number }>(app, 'main')
    await w.getByTestId('widget-time').click()
    await expect(page.getByTestId('note-title')).toBeVisible()
    // the main window is brought to the front on the note (hidden in test runs, so the request is what is checked)
    expect(await fake<{ presented: number; route: string }>(app, 'main')).toMatchObject({ presented: before.presented + 1, route: meeting })
    expect((await snap(app)).visible).toBe(false)
  } finally { await app.close() }
})

test('closing the foreground window reveals the recorder and its click reopens that meeting', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const meeting = (await fake<{ route: string }>(app, 'main')).route
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!
      main.isFocused = () => true
      main.isVisible = () => true
      main.emit('focus')
    })
    expect((await snap(app)).visible).toBe(false)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!
      // This fixture owns visibility; close now hides the same window instead of destroying it.
      main.isVisible = () => false
      main.close(); main.emit('hide')
    })
    await expect.poll(async () => (await snap(app)).visible).toBe(true)
    await w.getByTestId('widget-time').click()
    await expect.poll(async () => (await fake<{ route: string }>(app, 'main')).route).toBe(meeting)
    expect((await snap(app)).visible).toBe(false)
    await expect.poll(() => app.windows().some((p) => !p.url().includes('#') && !p.isClosed())).toBe(true)
    expect(page.isClosed()).toBe(false)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
  } finally { await app.close() }
})

test('the recorder hides when the main window is foregrounded and returns when it is backgrounded', async () => {
  const { app, page } = await launch()
  try {
    await record(app, page)
    expect((await snap(app)).visible).toBe(true)
    // Hidden test windows never receive macOS focus. Exercise the same native focus/blur events directly.
    const foreground = (value: boolean) => app.evaluate(({ BrowserWindow }, value) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!
      main.isFocused = () => value
      main.isVisible = () => true
      main.emit(value ? 'focus' : 'blur')
    }, value)
    await foreground(true)
    expect((await snap(app)).visible).toBe(false)
    // Renames/hints and first sizing must not re-show it over the foreground app.
    await fake(app, 'warn', 'no-system-audio')
    expect((await snap(app)).visible).toBe(false)
    await foreground(false)
    expect((await snap(app)).visible).toBe(true)
    await page.getByTestId('note-stop').click()
    await foreground(true)
    expect((await snap(app)).visible).toBe(false)
  } finally { await app.close() }
})

test('a helper that dies once is restarted with a hiccup note; dying again stops the meeting and keeps the notes', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    await fake(app, 'crashCapture')
    const preview = await windowOf(app, '#widget')
    await expect(preview.getByTestId('widget-note')).toHaveText('Recording hiccup. Still going.')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // The warning leaves after 4 s; the hidden conversation stays mounted for the next hover.
    await expect(preview.getByTestId('widget-note')).toHaveCount(0, { timeout: 8000 })
    expect(preview.isClosed()).toBe(false)
    // levels flow again from the new helper
    await expect.poll(async () => Number(await w.getByTestId('widget-wave').getAttribute('data-level')), { timeout: 15_000 }).toBeGreaterThan(0.05)
    await fake(app, 'crashCapture')
    await expect.poll(() => w.isClosed()).toBe(true)
    expect((await snap(app)).visible).toBe(false)
    expect((await snap(app)).notice?.title).toBe('Recording stopped. Your notes are safe.')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
  } finally { await app.close() }
})

test('hints retain both unavailable recording inputs', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const before = (await snap(app)).bounds!
    await fake(app, 'warn', 'no-system-audio')
    const preview = await windowOf(app, '#widget')
    await expect(preview.getByTestId('widget-note')).toHaveText("Yogurt can't hear the call audio. Allow it in System Settings.")
    await fake(app, 'warn', 'no-mic')
    await expect(preview.getByTestId('widget-note')).toContainText("Yogurt can't hear your microphone or the call.")
    // Warnings expand the recorder without changing its saved pill bounds.
    expect((await snap(app)).bounds).toEqual(before)
    await w.mouse.move(0, 0)
    await w.waitForTimeout(220)
    await expect(preview.getByTestId('widget-note')).toBeVisible()
    await page.getByTestId('note-pause').click()
    await expect(w.getByTestId('widget')).toHaveCount(0)
    await expect(preview.getByTestId('widget')).toHaveCount(0)
    expect((await snap(app)).visible).toBe(false)
    expect((await snap(app)).bounds).toEqual(before)
    await expect(page.getByTestId('rec-hint')).toContainText("Yogurt can't hear your microphone or the call.")
  } finally { await app.close() }
})

test('with reduced motion the meter stays three static dots', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const drawn = (id: string) => w.getByTestId(id).evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0))
    // the setting changing while the widget is up is picked up
    await w.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => drawn('widget-wave')).toBe(true)
    // and so is the page opening with it already on
    await w.reload()
    await expect(w.getByTestId('widget-time')).toBeVisible()
    await expect.poll(() => drawn('widget-wave')).toBe(true)
  } finally { await app.close() }
})

test('the card and the widget speak the interface language, like the main window', async () => {
  // Hebrew reads right to left, so the page's direction shows the language took even before its table exists
  const { app, page } = await launch({ language: 'he' })
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'he')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    const card = await windowOf(app, '#prompt')
    await expect(card.locator('html')).toHaveAttribute('lang', 'he')
    await expect(card.locator('html')).toHaveAttribute('dir', 'rtl')
    await card.getByTestId('prompt-take-notes').click()
    const w = await windowOf(app, '#widget')
    await expect(w.locator('html')).toHaveAttribute('lang', 'he')
    await expect(w.locator('html')).toHaveAttribute('dir', 'rtl')
  } finally { await app.close() }
})


test('keyboard Enter and Space open the meeting from the widget', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    for (const key of ['Enter', 'Space']) {
      const before = await fake<{ presented: number }>(app, 'main')
      await w.getByTestId('widget').press(key)
      await expect.poll(async () => (await fake<{ presented: number }>(app, 'main')).presented).toBe(before.presented + 1)
    }
  } finally { await app.close() }
})

test('hover stays stationary and pointer-down movement drags immediately without opening the note', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const widget = w.getByTestId('widget')
    // the pill hugs its content: the same space at both ends
    // measured once it settles: the pill resizes to its timer and animates there; 13 is 12 inside the 1px border
    await expect.poll(() => widget.evaluate(el => { const r = el.getBoundingClientRect(), a = el.querySelector('.widget-details > :first-child')!.getBoundingClientRect(), z = el.querySelector('[data-testid=widget-time]')!.getBoundingClientRect(); return [Math.round(a.left - r.left), Math.round(r.right - z.right)] })).toEqual([13, 13])
    const before = (await snap(app)).bounds!
    const box = (await w.getByTestId('widget').boundingBox())!
    const presented = (await fake<{ presented: number }>(app, 'main')).presented
    await w.mouse.move(box.x + 50, box.y + 20)
    const preview = await windowOf(app, '#widget')
    await expect(w.getByTestId('widget')).toHaveAttribute('data-open', 'true')
    await expect(preview.getByTestId('widget-preview')).toBeVisible()
    expect((await snap(app)).bounds).toEqual(before)
    await expect(preview.getByTestId('widget-preview-text')).not.toHaveText('Listening for speech…', { timeout: 30_000 })
    // Hover movement alone is never a drag.
    await w.mouse.move(box.x + 20, box.y + 35)
    expect((await snap(app)).bounds).toEqual(before)
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presented)
    await w.mouse.move(box.x + 50, box.y + 20)
    await w.mouse.down()
    await w.mouse.move(box.x + 20, box.y + 35)
    await w.mouse.up()
    await expect.poll(async () => (await snap(app)).bounds!.x).toBe(before.x - 30)
    expect((await snap(app)).bounds!.y).toBe(before.y + 15)
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presented)
  } finally { await app.close() }
})

test('pointer movement below the drag threshold still opens the note without moving the recorder', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const before = (await snap(app)).bounds!
    const box = (await w.getByTestId('widget').boundingBox())!
    const presented = (await fake<{ presented: number }>(app, 'main')).presented
    await w.mouse.move(box.x + 50, box.y + 20)
    await w.mouse.down()
    await w.mouse.move(box.x + 52, box.y + 22)
    await w.mouse.up()
    expect((await snap(app)).bounds).toEqual(before)
    await expect.poll(async () => (await fake<{ presented: number }>(app, 'main')).presented).toBe(presented + 1)
  } finally { await app.close() }
})

test('holding the pill does not open the note and a held press can still drag', async () => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    const before = (await snap(app)).bounds!
    const box = (await w.getByTestId('widget').boundingBox())!
    const presented = (await fake<{ presented: number }>(app, 'main')).presented
    await w.mouse.move(box.x + 50, box.y + 20)
    await w.mouse.down()
    await w.waitForTimeout(600)
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presented)
    await w.mouse.up()
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presented)
    expect((await snap(app)).bounds).toEqual(before)
    await w.mouse.down()
    await w.waitForTimeout(600)
    await w.mouse.move(box.x + 20, box.y + 30)
    await w.mouse.up()
    await expect.poll(async () => (await snap(app)).bounds!.x).toBe(before.x - 30)
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presented)
  } finally { await app.close() }
})

test('hover transcript shows a readable conversation and keeps your place when new speech arrives', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    await w.getByTestId('widget').hover()
    await expect(w.getByTestId('widget')).toHaveAttribute('data-open', 'true')
    const preview = await windowOf(app, '#widget')
    await expect(w.getByTestId('widget')).toHaveCSS('width', '340px')
    await expect(preview.getByTestId('widget-preview-loading')).toHaveCount(0)
    const id = await page.getByTestId('note').getAttribute('data-meeting-id') || await page.evaluate(() => window.yogurt.widget.state().then(v => v!.meetingId))
    const send = async (start: number, count: number) => app.evaluate(({ BrowserWindow }, { id, start, count }) => {
      const target = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('#widget'))!
      for (let i = start; i < start + count; i++) target.webContents.send('transcript:segment', {
        meetingId: id, track: i % 2 ? 'me' : 'them', startMs: 100000 + i * 3000, endMs: 102000 + i * 3000,
        speaker: i % 2 ? 'me' : 'Alex', text: `Conversation line ${i + 1}. We should keep the next step clear.`,
      })
    }, { id, start, count })
    await send(0, 24)
    const log = preview.getByTestId('widget-preview-text')
    await expect(preview.getByTestId('widget-preview-bubble')).toHaveCount(24)
    await expect(w.getByTestId('widget')).toHaveCSS('height', '390px')
    if (process.env.YOGURT_UI_REVIEW !== 'before') {
      await expect(log).toHaveCSS('overflow-y', 'scroll')
      const scrollbar = () => log.evaluate(el => ({ width: getComputedStyle(el, '::-webkit-scrollbar').width, color: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor, gutter: el.getBoundingClientRect().width - el.clientWidth }))
      const resting = await scrollbar()
      expect(resting).toMatchObject({ width: '4px', color: 'rgba(255, 255, 255, 0.314)' })
      expect(resting.gutter).toBe(4)
      const spacing = await log.evaluate(el => {
        const card = el.closest('.widget-preview')!
        const bubble = el.querySelector('.widget-preview-bubble')!
        return {
          edge: card.getBoundingClientRect().right - el.getBoundingClientRect().right,
          bubbleGap: el.getBoundingClientRect().right - bubble.getBoundingClientRect().right,
          overflow: el.scrollWidth - el.clientWidth,
        }
      })
      expect(spacing.edge).toBe(4) // the body has a 4px inset
      expect(spacing.bubbleGap).toBeLessThanOrEqual(8) // 4px scrollbar and 4px breathing room
      expect(spacing.overflow).toBe(0)
      await log.hover()
      expect(await scrollbar()).toEqual(resting)
    }
    await expect(log).toContainText('Alex')
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await send(24, 1)
    expect(await log.evaluate(el => el.scrollTop)).toBe(0)
    await expect(preview.getByTestId('widget-preview-latest')).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await preview.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await preview.getByTestId('widget-time').hover()
      await preview.screenshot({ path: testInfo.outputPath(`preview-${colorScheme}-before-latest.png`) })
    }
    const mainState = () => app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!
      return { bounds: main.getBounds(), visible: main.isVisible(), focused: main.isFocused(), minimized: main.isMinimized() }
    })
    const mainBefore = await mainState()
    const presentedBefore = (await fake<{ presented: number }>(app, 'main')).presented
    await preview.getByTestId('widget-preview-latest').click()
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    expect(await mainState()).toEqual(mainBefore)
    expect((await fake<{ presented: number }>(app, 'main')).presented).toBe(presentedBefore)
    await expect(preview.getByTestId('widget-preview-latest')).toHaveCount(0)
    for (const colorScheme of ['light', 'dark'] as const) {
      await preview.emulateMedia({ colorScheme })
      await preview.screenshot({ path: testInfo.outputPath(`preview-${colorScheme}-latest.png`) })
    }
    const before = (await fake<{ presented: number }>(app, 'main')).presented
    if (process.env.YOGURT_UI_REVIEW !== 'before') {
      await expect(preview.getByTestId('widget-preview-open')).toHaveCount(0)
      await expect(preview.locator('.widget-preview-header')).toHaveCount(0)
    }
    await w.getByTestId('widget-time').click()
    await expect.poll(async () => (await fake<{ presented: number }>(app, 'main')).presented).toBe(before + 1)
  } finally { await app.close() }
})

test('hover groups speaker runs and keeps live words stable through updates and a final line', async ({}, testInfo) => {
  const { app, page } = await launch()
  try {
    const w = await record(app, page)
    await w.getByTestId('widget').hover()
    await expect(w.getByTestId('widget')).toHaveAttribute('data-open', 'true')
    const preview = await windowOf(app, '#widget')
    await expect(preview.getByTestId('widget-preview')).toBeVisible()
    await expect(preview.getByTestId('widget-preview-loading')).toHaveCount(0)
    const id = await page.evaluate(() => window.yogurt.widget.state().then(v => v!.meetingId))
    const send = (channel: string, value: object) => app.evaluate(({ BrowserWindow }, { channel, value, id }) => {
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('#widget'))!.webContents.send(channel, { meetingId: id, ...value })
    }, { channel, value, id })
    await send('transcript:segment', { track: 'them', speaker: 'Alex', startMs: 100000, endMs: 102000, text: 'The launch checklist is ready.' })
    await send('transcript:segment', { track: 'them', speaker: 'Alex', startMs: 102200, endMs: 104000, text: 'We can share it after this call.' })
    await send('transcript:segment', { track: 'them', speaker: 'Alex', startMs: 106000, endMs: 108000, text: 'There is one thing left to confirm.' })
    const alex = preview.locator('.widget-preview-turn').filter({ hasText: 'The launch checklist is ready.' })
    await expect(alex.locator('.widget-preview-speaker')).toHaveText('Alex')
    await expect(alex.getByTestId('widget-preview-bubble')).toHaveCount(2)
    const partial = (extra: boolean) => ({ track: 'them', startMs: 108100, text: extra ? 'Which date works best?' : 'Which date works', words: [
      { text: 'Which', startMs: 108100, endMs: 108300 }, { text: 'date', startMs: 108300, endMs: 108500 },
      { text: 'works', startMs: 108500, endMs: 108700 }, ...(extra ? [{ text: 'best?', startMs: 108700, endMs: 108900 }] : []),
    ] })
    await send('transcript:partial', partial(false))
    const live = alex.getByTestId('transcript-partial')
    await expect(live).toContainText('Which date works')
    await live.locator('.live-word').first().evaluate(el => { el.setAttribute('data-kept', 'yes') })
    await send('transcript:partial', partial(true))
    await expect(live).toContainText('Which date works best?')
    await expect(live.locator('.live-word').first()).toHaveAttribute('data-kept', 'yes')
    await send('transcript:segment', { track: 'them', speaker: 'Alex', startMs: 108100, endMs: 108900, text: 'Which date works best?' })
    await expect(alex.getByTestId('transcript-partial')).toHaveCount(0)
    await expect(alex.getByTestId('widget-preview-bubble')).toHaveCount(2)
    expect((await alex.innerText()).match(/Which date works best\?/g)).toHaveLength(1)
    await preview.screenshot({ path: testInfo.outputPath('speaker-run.png') })
    for (let i = 0; i < 12; i++) await send('transcript:segment', {
      track: i % 2 ? 'me' : 'them', speaker: i % 2 ? 'me' : 'Jamie', startMs: 120000 + i * 4000, endMs: 123000 + i * 4000,
      text: i % 2 ? 'I can send the draft this afternoon, then we can review it together.' : 'That works. Let us keep the scope clear and check in tomorrow.',
    })
    await expect(w.getByTestId('widget')).toHaveCSS('height', '390px')
    const log = preview.getByTestId('widget-preview-text')
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    await preview.screenshot({ path: testInfo.outputPath('conversation-tall.png') })
    await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await w.mouse.move(0, 0)
    await preview.waitForTimeout(220)
    await w.getByTestId('widget-time').hover()
    expect(preview.isClosed()).toBe(false)
    expect(await log.evaluate(el => el.scrollTop)).toBe(0)
    await preview.getByTestId('widget-preview-latest').click()
    await log.dispatchEvent('wheel', { deltaY: -100 })
    await log.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await preview.waitForTimeout(300)
    expect(await log.evaluate(el => el.scrollTop)).toBe(0)
  } finally { await app.close() }
})
