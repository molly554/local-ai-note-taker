import { _electron as electron, expect, test } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

// CI only: the repository's no-local-E2E sentinel is enforced by playwright.config.ts.
// These commands use committed speech fixtures and testInfo.outputPath, never a person's profile or devices.
const run = promisify(execFile), tracks = ['me', 'them'] as const
const helper = join(import.meta.dirname, '../resources/bin/yogurt-audio')
const main = join(import.meta.dirname, '../out/main/index.js')
type Inspection = { durationMs: number; tracks: Record<string, { formatID: number; sampleRate: number; channels: number; bitsPerSecond: number; durationMs: number }> }
const inspect = async (dir: string): Promise<Inspection> => JSON.parse((await run(helper, ['inspect', '--dir', dir])).stdout)
function liveAtoms(path: string) {
  const bytes = readFileSync(path), names: string[] = []
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size32 = bytes.readUInt32BE(offset)
    if (size32 === 1 && offset + 16 > bytes.length) break
    const size = size32 === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : size32 || bytes.length - offset
    if (size < 8) throw new Error('Invalid M4A atom')
    if (offset + size > bytes.length) break // The writer may still be appending its final, unfinished atom.
    names.push(bytes.toString('ascii', offset + 4, offset + 8)); offset += size
  }
  return names
}

test('HE-AAC 16k preserves both tracks, mixed legacy joins and Chromium playback seeking', async ({}, info) => {
  test.setTimeout(120_000)
  const legacy = info.outputPath('legacy'), compact = info.outputPath('compact'), mixed = info.outputPath('mixed')
  for (const dir of [legacy, compact, mixed]) mkdirSync(dir, { recursive: true })
  for (const track of tracks) {
    await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac@48000', '-b', '64000', '-c', '1', join(import.meta.dirname, 'fixtures', `meeting-${track}.wav`), join(legacy, `${track}.m4a`)])
  }
  const original = await inspect(legacy)
  const durations = JSON.parse((await run(helper, ['compact', '--dir', legacy, '--out', compact])).stdout) as Record<string, { sourceMs: number; outputMs: number }>
  const converted = await inspect(compact)
  for (const track of tracks) {
    expect(Math.abs(durations[track].sourceMs - durations[track].outputMs)).toBeLessThanOrEqual(1000)
    expect(converted.tracks[track].formatID).toBe(0x61616368) // Richest decodable profile: HE ('aach'), not its compatible AAC-LC core.
    expect(converted.tracks[track].channels).toBe(1)
    expect([48000, 32000]).toContain(converted.tracks[track].sampleRate)
    // AVEncoderBitRateKey is 16,000; estimatedDataRate measures this file's VBR average,
    // which drops during the fixture's silence. A quality floor on that average is meaningless.
    expect(converted.tracks[track].bitsPerSecond).toBeGreaterThan(0)
    expect(converted.tracks[track].bitsPerSecond).toBeLessThan(20_000)
    expect(statSync(join(compact, `${track}.m4a`)).size).toBeLessThan(statSync(join(legacy, `${track}.m4a`)).size * 0.6)
    copyFileSync(join(legacy, `${track}.m4a`), join(mixed, `${track}.m4a`))
    copyFileSync(join(compact, `${track}.m4a`), join(mixed, `${track}.1.m4a`))
  }
  // The file conversion helper leaves a fresh HE recording unchanged.
  const repeated = info.outputPath('already-compact'); mkdirSync(repeated)
  expect(JSON.parse((await run(helper, ['compact', '--dir', compact, '--out', repeated])).stdout)).toBe(null)
  expect(readdirSync(repeated)).toEqual([])
  writeFileSync(join(mixed, 'part.1.json'), JSON.stringify({ startMs: original.durationMs }))
  await run(helper, ['join', '--dir', mixed])
  const joined = await inspect(mixed)
  expect(Math.abs(joined.durationMs - original.durationMs - converted.durationMs)).toBeLessThanOrEqual(1000)
  for (const track of tracks) expect(Math.abs(joined.tracks[track].durationMs - original.tracks[track].durationMs - converted.tracks[track].durationMs)).toBeLessThanOrEqual(1000)
  const originals = readdirSync(join(mixed, 'original')).map(name => readFileSync(join(mixed, 'original', name)))
  for (const track of tracks) expect(originals.some(bytes => bytes.equals(readFileSync(join(legacy, `${track}.m4a`))))).toBe(true)
  expect(readdirSync(mixed).some(name => /\.1\.m4a$|^part\./.test(name))).toBe(false)

  const failed = info.outputPath('failed-join'); mkdirSync(failed)
  for (const track of tracks) {
    copyFileSync(join(legacy, `${track}.m4a`), join(failed, `${track}.m4a`))
    writeFileSync(join(failed, `${track}.1.m4a`), 'unreadable interrupted fragment')
  }
  writeFileSync(join(failed, 'part.1.json'), JSON.stringify({ startMs: original.durationMs }))
  await expect(run(helper, ['join', '--dir', failed])).rejects.toThrow()
  for (const track of tracks) {
    expect(readFileSync(join(failed, `${track}.m4a`))).toEqual(readFileSync(join(legacy, `${track}.m4a`)))
    expect(readFileSync(join(failed, `${track}.1.m4a`), 'utf8')).toBe('unreadable interrupted fragment')
  }

  const userData = info.outputPath('profile')
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_AUDIO_M4A: '1', YOGURT_USER_DATA: userData } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(12))
    const meeting = join(userData, 'meetings', id); mkdirSync(meeting, { recursive: true })
    for (const track of tracks) copyFileSync(join(mixed, `${track}.m4a`), join(meeting, `${track}.m4a`))
    await app.evaluate((_electron, id) => (globalThis as unknown as { __fake__: { go(route: string): void } }).__fake__.go(`/note/${id}`), id)
    await page.getByTestId('note-transcript-toggle').click()
    const audio = page.locator('[data-testid="player"] audio')
    await expect(audio).toHaveCount(2)
    const state = () => audio.evaluateAll(els => els.map(el => { const a = el as HTMLAudioElement; return { duration: a.duration, time: a.currentTime, paused: a.paused, error: a.error?.code ?? null } }))
    await expect.poll(async () => (await state()).every(a => a.error === null && a.duration > 30 && a.duration < 36)).toBe(true)
    await page.getByTestId('player-toggle').click()
    await expect.poll(async () => (await state()).every(a => !a.paused && a.time > 0)).toBe(true)
    await page.getByTestId('player-toggle').click()
    await page.getByTestId('player-scrubber').fill('24')
    await expect.poll(async () => (await state()).every(a => a.error === null && a.paused && Math.abs(a.time - 24) < 0.1)).toBe(true)
    await page.getByTestId('player-toggle').click()
    await expect.poll(async () => (await state()).every(a => !a.paused && a.time > 24)).toBe(true)
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('audio-storage')).toHaveCount(0)
    await expect(page.getByTestId('audio-delete-originals')).toHaveCount(0)
  } finally { await app.close() }
})

test('a transcript click queued before metadata still plays the healthy track if the other track fails later', async ({}, info) => {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_AUDIO_METADATA_GATE: '1', YOGURT_USER_DATA: info.outputPath('partial-profile') } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(24))
    await app.evaluate((_electron, id) => (globalThis as unknown as { __fake__: { go(route: string): void } }).__fake__.go(`/note/${id}`), id)
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('player')).toBeVisible()
    // Model the ordering explicitly: one metadata event succeeds; the other stays unreadable, then errors.
    await page.getByTestId('player-audio-them').evaluate(el => Object.defineProperty(el, 'readyState', { configurable: true, get: () => 0 }))
    await page.getByTestId('transcript-line').first().click()
    await app.evaluate(() => (globalThis as unknown as { __fake__: { audioMetadataRelease(): void } }).__fake__.audioMetadataRelease())
    const healthy = page.getByTestId('player-audio-me')
    await expect.poll(() => healthy.evaluate(el => (el as HTMLAudioElement).readyState)).toBeGreaterThan(0)
    expect(await healthy.evaluate(el => (el as HTMLAudioElement).paused)).toBe(true)
    await page.getByTestId('player-audio-them').evaluate(el => el.dispatchEvent(new Event('error')))
    await expect(page.getByTestId('player-note')).toContainText("Part of this recording can't be played.")
    await expect.poll(() => healthy.evaluate(el => !(el as HTMLAudioElement).paused && (el as HTMLAudioElement).currentTime > 0)).toBe(true)
  } finally { await app.close() }
})

test('the live HE writer commits five-second fragments that remain readable after a crash and join with legacy audio', async ({}, info) => {
  test.setTimeout(90_000)
  const live = info.outputPath('interrupted'), mixed = info.outputPath('mixed-crash')
  mkdirSync(live, { recursive: true }); mkdirSync(mixed, { recursive: true })
  const child = spawn(helper, ['writer-probe', '--dir', live,
    '--me', join(import.meta.dirname, 'fixtures/meeting-me.wav'), '--them', join(import.meta.dirname, 'fixtures/meeting-them.wav')],
  { env: { ...process.env, YOGURT_AUDIO_TEST: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timer: ReturnType<typeof setTimeout> | undefined
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const fed = new Promise<{ inputMs: number; fragmentMs: number }>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`writer probe did not feed its fixture: ${stderr}`)), 35_000)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`writer probe exited before verification (${code}/${signal}): ${stderr}`)))
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    child.stdout.on('data', bytes => {
      stdout += String(bytes)
      const line = stdout.split('\n').slice(0, -1).find(value => value.includes('"writer-fed"'))
      if (line) {
        clearTimeout(timer)
        try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
      }
    })
  })
  try {
    const status = await fed
    expect(status.fragmentMs).toBe(5000)
    // Inspect before finalization folds the fragment records into the completed file.
    for (const track of tracks) await expect.poll(() => liveAtoms(join(live, `${track}.m4a`)).filter(atom => atom === 'moof').length).toBeGreaterThanOrEqual(2)
    child.kill('SIGKILL'); await closed
    const crashed = await inspect(live)
    expect(crashed.durationMs).toBeGreaterThanOrEqual(status.inputMs - status.fragmentMs - 1000)
    expect(crashed.durationMs).toBeLessThanOrEqual(status.inputMs + 1000)
    for (const track of tracks) {
      expect(crashed.tracks[track].formatID).toBe(0x61616368)
      expect(crashed.tracks[track].durationMs).toBeGreaterThanOrEqual(status.inputMs - status.fragmentMs - 1000)
      expect(crashed.tracks[track].durationMs).toBeLessThanOrEqual(status.inputMs + 1000)
      await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac@48000', '-b', '64000', '-c', '1', join(import.meta.dirname, 'fixtures', `meeting-${track}.wav`), join(mixed, `${track}.m4a`)])
    }
    const legacy = await inspect(mixed)
    const inputs = tracks.flatMap(track => [readFileSync(join(mixed, `${track}.m4a`)), readFileSync(join(live, `${track}.m4a`))])
    for (const track of tracks) copyFileSync(join(live, `${track}.m4a`), join(mixed, `${track}.1.m4a`))
    writeFileSync(join(mixed, 'part.1.json'), JSON.stringify({ startMs: legacy.durationMs }))
    // join decodes every committed source frame and validates the output's decoded duration before replacing files.
    await run(helper, ['join', '--dir', mixed])
    const joined = await inspect(mixed)
    expect(Math.abs(joined.durationMs - legacy.durationMs - crashed.durationMs)).toBeLessThanOrEqual(1000)
    for (const track of tracks) expect(Math.abs(joined.tracks[track].durationMs - legacy.tracks[track].durationMs - crashed.tracks[track].durationMs)).toBeLessThanOrEqual(1000)
    const originals = readdirSync(join(mixed, 'original')).map(name => readFileSync(join(mixed, 'original', name)))
    for (const input of inputs) expect(originals.some(bytes => bytes.equals(input))).toBe(true)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
})
