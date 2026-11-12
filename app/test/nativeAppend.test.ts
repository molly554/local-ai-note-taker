import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWav, wavOf } from '../src/main/fakeCapture'

// Local fixture-only check: compile the changed helper to a separate path. Never opens a microphone.
const helper = process.env.YOGURT_AUDIO_TEST_BIN
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'yogurt-native-append-')); dirs.push(dir); return dir }
const tone = (seconds: number, hz = 220) => wavOf([Float32Array.from({ length: seconds * 16_000 }, (_, i) => Math.sin(i * hz * 2 * Math.PI / 16_000) * 0.15)])
const writeTone = (dir: string, file: string, hz = 220, seconds = 1) => {
  const wav = join(dir, 'tone.wav'); writeFileSync(wav, tone(seconds, hz))
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wav, join(dir, file)], { timeout: 10_000 })
  return readFileSync(join(dir, file))
}
const run = (command: string, dir: string) => execFileSync(helper!, [command, '--dir', dir], { timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe.skipIf(!helper)('native fixture append (no recording)', () => {
  it('inspects retained audio and appends a new part once', () => {
    const dir = folder()
    for (const track of ['me', 'them']) writeTone(dir, `${track}.m4a`)
    const before = JSON.parse(run('inspect', dir))
    expect(before.durationMs).toBeGreaterThanOrEqual(1000)
    expect(before.durationMs).toBeLessThan(1100)
    writeFileSync(join(dir, 'part.1.json'), JSON.stringify({ startMs: before.durationMs }))
    for (const track of ['me', 'them']) writeTone(dir, `${track}.1.m4a`, 440)
    run('join', dir)
    const after = JSON.parse(run('inspect', dir))
    expect(after.durationMs).toBeGreaterThanOrEqual(1950)
    expect(after.durationMs).toBeLessThan(2200)
    expect(existsSync(join(dir, 'part.1.json'))).toBe(false)
    const decoded = join(dir, 'decoded.wav')
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', join(dir, 'me.m4a'), decoded])
    const samples = readWav(decoded)
    const hz = (start: number) => {
      const part = samples.subarray(Math.round(start * 16000), Math.round((start + 0.5) * 16000))
      return part.reduce((count, sample, i) => count + (i > 0 && part[i - 1] < 0 && sample >= 0 ? 1 : 0), 0) / 0.5
    }
    expect(hz(0.2)).toBeCloseTo(220, -1)
    expect(hz(1.3)).toBeCloseTo(440, -1)
    const bytes = readFileSync(join(dir, 'me.m4a'))
    run('join', dir)
    expect(readFileSync(join(dir, 'me.m4a'))).toEqual(bytes)
  })
  it('a short new part is not mistaken for an already joined part', () => {
    const dir = folder(); writeTone(dir, 'me.m4a')
    const before = JSON.parse(run('inspect', dir)).durationMs
    writeFileSync(join(dir, 'part.1.json'), JSON.stringify({ startMs: before }))
    writeTone(dir, 'me.1.m4a', 440, 0.02)
    run('join', dir)
    expect(JSON.parse(run('inspect', dir)).durationMs).toBeGreaterThan(before + 15)
  })
  it('an unreadable new part cannot replace or delete the original recording', () => {
    const dir = folder(), original = writeTone(dir, 'me.m4a')
    writeFileSync(join(dir, 'me.1.m4a'), 'unreadable audio')
    writeFileSync(join(dir, 'part.1.json'), JSON.stringify({ startMs: 1000 }))
    expect(() => run('join', dir)).toThrow()
    expect(readFileSync(join(dir, 'me.m4a'))).toEqual(original)
    expect(readFileSync(join(dir, 'me.1.m4a'), 'utf8')).toBe('unreadable audio')
    expect(existsSync(join(dir, 'part.1.json'))).toBe(true)
    expect(() => run('inspect', dir)).toThrow()
  })
})
