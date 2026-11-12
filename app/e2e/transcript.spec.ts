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

/** who heads the turn a line is in */
const whoOf = (page: Page, text: string) => page.getByTestId('transcript-turn').filter({ has: page.getByTestId('transcript-line').filter({ hasText: text }) }).getByTestId('transcript-who')

test('live, each turn says who: You on the mic, and the name the call app shows talking on the other side', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    // the fixtures' first phrases: me at 0.5 s, them at 5.2 s (each line shows after the pause that ends it); the fake Zoom marks Ann Lee then
    const lines = page.getByTestId('transcript-line')
    const mine = lines.filter({ hasText: 'Can we go over the launch plan' }), theirs = lines.filter({ hasText: 'The site goes live on Tuesday' })
    await expect(mine).toHaveText(/^Hi, thanks for joining/, { timeout: 30_000 })
    await expect(theirs).toHaveText(/^Sure\./, { timeout: 30_000 })
    await expect(theirs).toHaveAttribute('data-track', 'them')
    await expect(whoOf(page, 'Can we go over the launch plan')).toHaveText('You')
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ann Lee')
    // Bo Park is marked for the second line
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Bo Park', { timeout: 40_000 })
    // the same after the meeting
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await expect(whoOf(page, 'Can we go over the launch plan')).toHaveText('You', { timeout: 15_000 })
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Ann Lee')
    await expect(whoOf(page, 'She will send a draft')).toHaveText('Bo Park')
    // everyone seen in the call is at the meeting now, the person using Yogurt left out
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((i) => window.yogurt.meetings.get(i), id))?.attendees.map((a) => a.name)).toEqual(['Ann Lee', 'Bo Park', 'Cy Dao'])
  } finally { await app.close() }
})

test('while someone talks, a quick lighter reading shows first; the final line replaces it', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const partial = page.getByTestId('transcript-partial')
    // the first sentence runs a few seconds: its first words show well before it is over
    await expect(partial.first()).toBeVisible({ timeout: 15_000 })
    await expect(partial.first()).toContainText(/^Hi, thanks/)
    expect(await page.getByTestId('transcript-line').count()).toBe(0)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' })).toBeVisible({ timeout: 30_000 })
    await expect(partial.filter({ hasText: 'Hi, thanks' })).toHaveCount(0)
    // it took the reading's place: no fade-in from nothing
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' })).not.toHaveClass(/line-in/)
  } finally { await app.close() }
})

test("with Apple's on-device speech (macOS 26), its words show as they are said and the final line replaces them", async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_SPEECH: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const partial = page.getByTestId('transcript-partial')
    // Apple's first reading comes 0.7 s into the sentence, well before whisper's line (which ends it)
    await expect(partial.filter({ hasText: 'Hi, thanks for' })).toBeVisible({ timeout: 10_000 })
    await expect(partial.first()).toHaveAttribute('data-track', 'me')
    expect(await page.getByTestId('transcript-line').count()).toBe(0)
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'Can we go over the launch plan' })).toBeVisible({ timeout: 30_000 })
    await expect(partial.filter({ hasText: 'Hi, thanks' })).toHaveCount(0)
  } finally { await app.close() }
})

test('opening the note mid-meeting shows the lines already heard', async () => {
  const { app, page } = await launch()
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 30_000 })
    // a reload loses what the page heard; the note asks the app for the saved lines again
    await page.reload()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible()
  } finally { await app.close() }
})

test('Transcript is a primary page: Escape keeps it open and Notes switches away', async () => {
  const { app, page } = await launch()
  try {
    const id = await fake<string>(app, 'bigMeeting', 20)
    await fake(app, 'go', `/note/${id}`)
    const transcript = page.getByRole('tab', { name: 'Transcript', exact: true })
    const notes = page.getByRole('tab', { name: 'My notes', exact: true })
    await transcript.click()
    await expect(transcript).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(page.getByTestId('transcript-close')).toHaveCount(0)
    const search = page.getByTestId('transcript-search')
    await expect(page.locator('.note-primary-tabs').getByTestId('transcript-search')).toBeVisible()
    expect((await search.boundingBox())!.width).toBeLessThan(130)
    await search.click()
    await expect.poll(async () => (await search.boundingBox())!.width).toBeGreaterThan(160)
    await page.getByTestId('transcript-search').fill('unlikely phrase with no matches')
    await transcript.click()
    expect((await search.boundingBox())!.width).toBeGreaterThan(160)
    await search.fill('')
    await transcript.click()
    await expect.poll(async () => (await search.boundingBox())!.width).toBeLessThan(130)
    await search.fill('unlikely phrase with no matches')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('transcript-search')).toHaveValue('unlikely phrase with no matches')
    await expect(page.getByTestId('transcript-panel')).toBeVisible()
    await expect(transcript).toHaveAttribute('aria-selected', 'true')
    await notes.click()
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('transcript-panel')).toBeHidden()
  } finally { await app.close() }
})

test('transcription trouble shows in the widget in plain words', async () => {
  const { app, page } = await launch({ YOGURT_BACKGROUND: '1' })
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await fake(app, 'warn', 'falling-behind')
    // the recorder shows a warning sign; the words are inside the expanded recorder
    const w = await windowOf(app, '#widget')
    await expect(w.getByTestId('widget-note')).toHaveText('Lynote NoteTaker is falling behind. Some lines may be missing.')
    await fake(app, 'warn', 'transcribe-failed')
    await expect(w.getByTestId('widget-note')).toHaveText("Some of this meeting couldn't be transcribed.")
  } finally { await app.close() }
})

test('without Accessibility the other side is Them, live and after; nothing is guessed', async () => {
  const { app, page } = await launch({ YOGURT_FAKE_AX: 'denied' })
  try {
    await fake(app, 'signals', { micApps: [zoom], events: [] })
    await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(lines.filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    // both lines of the other side are one Them turn
    await expect(whoOf(page, 'The site goes live on Tuesday')).toHaveText('Them')
    await expect(page.getByTestId('transcript')).not.toContainText(/Ann Lee|Bo Park|Speaker/)
  } finally { await app.close() }
})

const startMeeting = async (app: ElectronApplication, page: Page) => {
  await fake(app, 'signals', { micApps: [zoom], events: [] })
  await (await windowOf(app, '#prompt')).getByTestId('prompt-take-notes').click()
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
}
const audioOf = (page: Page) => page.locator('[data-testid^="player-audio-"]')
const audioState = (page: Page) => audioOf(page).evaluateAll((els) => (els as HTMLAudioElement[]).map((a) => ({ track: a.dataset.track, time: a.currentTime, paused: a.paused, rate: a.playbackRate })))

test('each line shows when it was said, from the start of the meeting; no player while recording', async () => {
  const { app, page } = await launch()
  try {
    await startMeeting(app, page)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'Can we go over the launch plan' }).getByTestId('transcript-time')).toHaveText('0:00', { timeout: 30_000 })
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' }).getByTestId('transcript-time')).toHaveText('0:05', { timeout: 30_000 })
    await expect(page.getByTestId('player')).toHaveCount(0)
  } finally { await app.close() }
})

test('the transcript follows new lines, unless the person scrolled up to read', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startMeeting(app, page)
    const list = page.getByTestId('transcript')
    await expect(list).toBeVisible()
    // a short list, so a few lines overflow it
    await list.evaluate((el) => { el.style.flex = 'none'; el.style.height = '60px' })
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'The site goes live on Tuesday' })).toBeVisible({ timeout: 30_000 })
    const atBottom = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
    await expect.poll(atBottom).toBe(true)
    await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(lines.filter({ hasText: 'Who is writing the release notes' })).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(300)
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
    // the pill takes them back to the newest line, and following goes on
    // Reduced motion reaches the newest line immediately, with no smooth-scroll travel.
    expect(await page.getByTestId('transcript-latest').evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      const list = document.querySelector('[data-testid="transcript"]')!
      return list.scrollHeight - list.scrollTop - list.clientHeight < 4
    })).toBe(true)
    await expect.poll(atBottom).toBe(true)
    await expect(page.getByTestId('transcript-latest')).toHaveCount(0)
    await expect(lines.filter({ hasText: 'She will send a draft' })).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(atBottom).toBe(true)
  } finally { await app.close() }
})

test('after the meeting, clicking a line plays both sides from a second before it, with pause and speed', async () => {
  const { app, page } = await launch()
  try {
    await startMeeting(app, page)
    const lines = page.getByTestId('transcript-line')
    await expect(lines.filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
    await expect(audioOf(page)).toHaveCount(2)
    // the line at 13.3 s plays from 12.3 s, on both tracks
    await lines.filter({ hasText: 'She will send a draft' }).getByText('She will send a draft').click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2 && a.time < 14.5)).toBe(true)
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // faster, on both
    await page.getByTestId('player-speed').click()
    await expect(page.getByTestId('player-speed')).toHaveText('1.5×')
    await expect.poll(async () => (await audioState(page)).map((a) => a.rate)).toEqual([1.5, 1.5])
    await page.getByTestId('player-speed').click()
    await expect.poll(async () => (await audioState(page)).map((a) => a.rate)).toEqual([2, 2])
    // the line being played is marked, theirs as well as yours
    const playingLine = page.locator('[data-testid="transcript-line"][data-playing]')
    await expect(playingLine).toHaveCount(1)
    await expect(playingLine).toContainText('She will send a draft')
    await page.getByTestId('player-toggle').click()
    await expect.poll(async () => (await audioState(page)).every((a) => a.paused)).toBe(true)
    // paused, the mark stays where it stopped
    await expect(playingLine).toContainText('She will send a draft')
    // the scrubber moves both, and the mark jumps with it at once, while paused too
    await page.getByTestId('player-scrubber').fill('3')
    await expect.poll(async () => (await audioState(page)).map((a) => Math.round(a.time))).toEqual([3, 3])
    await expect(playingLine).toContainText('Can we go over the launch plan')
    await page.getByTestId('player-scrubber').fill('6')
    await expect(playingLine).toHaveAttribute('data-track', 'them')
    // a line near the start never seeks before 0
    await lines.filter({ hasText: 'Can we go over the launch plan' }).getByText('Can we go over').click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time < 1.5)).toBe(true)
    const tracks = await audioOf(page).elementHandles()
    await page.getByRole('tab', { name: 'My notes', exact: true }).click()
    await expect(page.getByTestId('player')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'My notes', exact: true })).toBeFocused()
    for (const track of tracks) expect(await track.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(true)
  } finally { await app.close() }
})

/** a stopped meeting with its player ready; returns its id */
async function stopped(app: ElectronApplication, page: Page) {
  await startMeeting(app, page)
  await expect(page.getByTestId('transcript-line').filter({ hasText: 'She will send a draft' })).toBeVisible({ timeout: 40_000 })
  await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
  return (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
}

test('the transcript scrolls behind its player and the final line can clear the controls', async () => {
  const { app, page } = await launch()
  try {
    await stopped(app, page)
    const list = page.getByTestId('transcript'), player = page.getByTestId('player')
    const bottom = (await list.boundingBox())!
    const controls = (await player.boundingBox())!
    expect(bottom.y + bottom.height).toBeGreaterThan(controls.y + controls.height)
    const footer = (await page.locator('.note-footer').boundingBox())!
    expect(footer.y - controls.y - controls.height).toBeLessThanOrEqual(12)
    await list.evaluate(el => { el.scrollTop = el.scrollHeight })
    const last = (await page.getByTestId('transcript-turn').last().boundingBox())!
    expect(last.y + last.height).toBeLessThan(controls.y)
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    await page.getByTestId('player-speed').click()
    await expect(page.getByTestId('player-speed')).toHaveText('1.5×')
  } finally { await app.close() }
})
/** replaces a track's stand-in file: seconds of silence, or bytes that are not audio, or nothing */
const setTrack = (app: ElectronApplication, id: string, track: string, what: number | 'garbage' | 'gone') =>
  app.evaluate((_e, [id, track, what]) => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs'), path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const file = path.join(process.env.YOGURT_USER_DATA!, 'meetings', id, `${track}.wav`)
    if (what === 'gone') { fs.rmSync(file); return }
    if (what === 'garbage') { fs.writeFileSync(file, Buffer.alloc(4000, 7)); return }
    const n = (what as number) * 16000, b = Buffer.alloc(44 + n * 2)
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
    fs.writeFileSync(file, b)
  }, [id, track, what] as const)
const reopen = async (page: Page) => {
  await page.reload()
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 15_000 })
}

test('a side that ends early, is missing, or cannot be read: the other still plays', async () => {
  const { app, page } = await launch()
  try {
    const id = await stopped(app, page)
    const lines = page.getByTestId('transcript-line')
    // their side is only 5 s long: the line at 13.3 s plays your side, and the button says it is playing
    await setTrack(app, id, 'them', 5)
    await reopen(page)
    await expect.poll(async () => (await audioState(page)).length).toBe(2)
    await lines.filter({ hasText: 'She will send a draft' }).getByText('She will send a draft').click()
    await expect.poll(async () => (await audioState(page)).find((a) => a.track === 'me')).toMatchObject({ paused: false })
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // back to 2 s while playing: their side plays again too
    await page.getByTestId('player-scrubber').fill('2')
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time < 4)).toBe(true)
    // their side gone: one track plays
    await setTrack(app, id, 'them', 'gone')
    await reopen(page)
    await expect(audioOf(page)).toHaveCount(1)
    await lines.filter({ hasText: 'She will send a draft' }).getByText('She will send a draft').click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2)).toBe(true)
    // their side unreadable: it is dropped, they are told, and your side plays
    await setTrack(app, id, 'them', 'garbage')
    await reopen(page)
    await expect(page.getByTestId('player-note')).toHaveText("Part of this recording can't be played.")
    await expect(audioOf(page)).toHaveCount(1)
    await lines.filter({ hasText: 'She will send a draft' }).getByText('She will send a draft').click()
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2)).toBe(true)
    // nothing readable: no controls, just the note
    await setTrack(app, id, 'me', 'garbage')
    await reopen(page).catch(() => {})
    await expect(page.getByTestId('player-note')).toHaveText("This recording can't be played.")
    await expect(page.getByTestId('player-toggle')).toHaveCount(0)
  } finally { await app.close() }
})

test('the play button follows the audio, and lines are one tab stop moved with the arrow keys', async () => {
  const { app, page } = await launch()
  try {
    await stopped(app, page)
    const lines = page.getByTestId('transcript-line')
    await lines.filter({ hasText: 'The site goes live' }).getByText('The site goes live').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Pause')
    // stopped by anything but the button (the system, an error): the button says Play
    await audioOf(page).evaluateAll((els) => (els as HTMLAudioElement[]).forEach((a) => a.pause()))
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    await expect(page.getByTestId('player-speed')).toHaveAttribute('aria-label', 'Playback speed 1×')
    // one line in the tab order; arrows move between lines, Enter plays
    expect(await lines.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(1)
    await expect(lines.first()).toHaveAttribute('role', 'button')
    await lines.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(lines.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
    await expect(lines.nth(3)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await audioState(page)).every((a) => !a.paused && a.time >= 12.2 && a.time < 14.5)).toBe(true)
  } finally { await app.close() }
})

test('a long meeting opens fast, and playing redraws only the line that changes', async () => {
  const { app, page } = await launch()
  try {
    const n = 3000
    const id = await fake<string>(app, 'bigMeeting', n)
    await fake(app, 'go', `/note/${id}`)
    await expect(page.getByTestId('note-title')).toBeVisible()
    const t0 = Date.now()
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-line')).toHaveCount(n)
    const opened = Date.now() - t0
    console.log(`${n} lines open in ${opened} ms`)
    expect(opened).toBeLessThan(3000)
    // lines already said do not animate in
    await expect(page.locator('.line-in')).toHaveCount(0)
    await expect(page.getByTestId('player')).toBeVisible()
    await page.evaluate(() => { (window as unknown as { __rowRenders: number }).__rowRenders = 0 })
    await page.getByTestId('transcript-line').nth(10).click()
    await page.waitForTimeout(2500)
    const renders = await page.evaluate(() => (window as unknown as { __rowRenders: number }).__rowRenders)
    console.log('row renders while playing 2.5 s:', renders)
    expect(renders).toBeLessThan(40)
  } finally { await app.close() }
})

/** a long finished meeting playing at 2× (lines half a second apart), with helpers to see where the line being played is */
async function playingLong(app: ElectronApplication, page: Page) {
  const id = await fake<string>(app, 'bigMeeting', 400)
  await fake(app, 'go', `/note/${id}`)
  await page.getByTestId('note-transcript-toggle').click()
  await expect(page.getByTestId('player')).toBeVisible()
  const list = page.getByTestId('transcript')
  const playingLine = page.locator('[data-testid="transcript-line"][data-playing]')
  const playingNo = async () => Number((await playingLine.textContent())?.match(/Line (\d+) /)?.[1])
  /** where the line being played sits in the list, as a share of its height (0 top, 1 bottom) */
  const where = () => page.evaluate(() => {
    const l = document.querySelector('[data-testid="transcript"]')!.getBoundingClientRect()
    const r = document.querySelector('[data-testid="transcript-line"][data-playing]')?.getBoundingClientRect()
    return r ? (r.top - l.top) / l.height : null
  })
  const comfy = async () => { const at = await where(); return at !== null && at > 0 && at < 0.75 }
  const scrollTop = () => list.evaluate((el) => el.scrollTop)
  const box = (await list.boundingBox())!
  /** they turn the wheel up over the list */
  const scrollUp = async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -100_000)
    await expect.poll(scrollTop).toBeLessThan(40)
  }
  await page.getByTestId('player-speed').click(); await page.getByTestId('player-speed').click()
  await expect(page.getByTestId('player-speed')).toHaveText('2×')
  // the panel settled, so a click lands where it is aimed
  await page.getByTestId('transcript-panel').evaluate((el) => Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)))
  return { playingLine, playingNo, where, comfy, scrollTop, scrollUp }
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`scrubbing follows the playhead while paused and after scrolling away (${reducedMotion})`, async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion })
    const { playingNo, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    const scrubber = page.getByTestId('player-scrubber')
    // Seeking while paused must move the viewport as well as the highlight.
    await scrubber.fill('30')
    await expect.poll(playingNo).toBe(61)
    await expect.poll(comfy).toBe(true)
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    // The seek glide finishes before checking that an idle paused player stays still.
    await page.waitForTimeout(300)
    const settled = await scrollTop()
    await page.waitForTimeout(500)
    expect(await scrollTop()).toBe(settled)

    // A fresh seek wins over reading elsewhere, even within the same highlighted line.
    await scrollUp()
    await scrubber.fill('30.1')
    await expect.poll(playingNo).toBe(61)
    await expect.poll(comfy).toBe(true)
    await scrubber.fill('5')
    await expect.poll(playingNo).toBe(11)
    await expect.poll(comfy).toBe(true)

    await page.getByTestId('player-toggle').click()
    await scrubber.fill('80')
    await expect.poll(comfy).toBe(true)
    await scrollUp()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    // Drag the real range control: its pointer gesture is not a transcript scroll.
    const box = (await scrubber.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(playingNo).toBeGreaterThan(250)
    await expect.poll(comfy).toBe(true)
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
  } finally { await app.close() }
})

test('playing follows along: the line being played moves down the list and stays in view; scrolling away stops it until Back to playing', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch()
  try {
    const { playingNo, where, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    // the mark moves line to line, from a second before the one clicked
    await page.getByTestId('transcript-line').nth(4).click()
    await expect.poll(playingNo).toBeGreaterThanOrEqual(4)
    const first = await playingNo()
    await expect.poll(playingNo).toBeGreaterThan(first + 2)
    // past the first screenful the list scrolls, keeping the line clear of the edges
    await expect.poll(playingNo, { timeout: 15_000 }).toBeGreaterThan(20)
    expect(await scrollTop()).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) {
      const at = await where()
      expect(at).not.toBeNull()
      expect(at!).toBeGreaterThan(0)
      expect(at!).toBeLessThan(0.75)
      await page.waitForTimeout(400)
    }
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)

    // they scroll back up to read: the list stays where they put it, and offers a way back
    await scrollUp()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    await expect(page.getByTestId('transcript-follow')).toHaveText('Back to playing')
    const left = await playingNo(), put = await scrollTop()
    await expect.poll(playingNo).toBeGreaterThan(left + 3)
    expect(await scrollTop()).toBe(put)

    // Back to playing brings the line back into view and follows again
    await page.getByTestId('transcript-follow').click()
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
    await expect.poll(comfy).toBe(true)
    const back = await playingNo()
    await expect.poll(playingNo, { timeout: 10_000 }).toBeGreaterThan(back + 8)
    await expect.poll(comfy).toBe(true)
  } finally { await app.close() }
})

test('paused, the mark stays and nothing scrolls; clicking a line follows again; a search that leaves the line out jumps nowhere', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch()
  try {
    const { playingLine, playingNo, comfy, scrollTop, scrollUp } = await playingLong(app, page)
    // the scrubber moves the mark at once, and the list with it
    await page.getByTestId('transcript-line').nth(2).click()
    await page.getByTestId('player-scrubber').fill('30')
    await expect.poll(playingNo).toBeGreaterThanOrEqual(61)
    await expect.poll(comfy).toBe(true)

    // paused: the mark stays, nothing scrolls
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('player-toggle')).toHaveAttribute('aria-label', 'Play')
    // a glide that began just before the pause finishes first
    await page.waitForTimeout(500)
    const stoppedAt = await playingNo(), top = await scrollTop()
    await page.waitForTimeout(1200)
    expect(await playingNo()).toBe(stoppedAt)
    expect(await scrollTop()).toBe(top)

    // scrolled away, then playing again: it doesn't pull them back; clicking a line plays from it and follows again
    await scrollUp()
    await page.getByTestId('player-toggle').click()
    await expect(page.getByTestId('transcript-follow')).toBeVisible()
    await page.getByTestId('transcript-line').nth(2).click()
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
    await expect.poll(playingNo, { timeout: 15_000 }).toBeGreaterThan(20)
    await expect.poll(comfy).toBe(true)

    // with less motion asked for, the list jumps instead of gliding
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('player-scrubber').fill('77.2')
    await expect.poll(playingNo).toBe(155)
    // Highlighting renders before the coalesced scroll frame, even when reduced motion jumps instead of gliding.
    await expect.poll(comfy).toBe(true)
    // a search that leaves the line being played out: nothing jumps (no line from 151 to 159 has a 0, 2 s at 2×)
    await page.getByTestId('transcript-search').fill('0')
    await expect(playingLine).toHaveCount(0)
    const searched = await scrollTop()
    await page.waitForTimeout(800)
    expect(await scrollTop()).toBe(searched)
    await expect(page.getByTestId('transcript-follow')).toHaveCount(0)
  } finally { await app.close() }
})
