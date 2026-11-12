import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
// @ts-expect-error plain script, no types
import { helperEntitlements } from '../scripts/sign.cjs'

const build = join(__dirname, '../build')
const keys = (file: string) => [...readFileSync(file, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort()
const bin = '/x/Yogurt.app/Contents/Resources/bin'

describe('each helper gets only what it uses', () => {
  it('yogurt-audio: the microphone', () => {
    expect(keys(helperEntitlements(`${bin}/yogurt-audio`, build))).toEqual(['com.apple.security.device.audio-input'])
  })
  it('yogurt-mac: calendars, Apple events (browsers, Music, Spotify) and the microphone question', () => {
    expect(keys(helperEntitlements(`${bin}/yogurt-mac`, build))).toEqual(['com.apple.security.automation.apple-events', 'com.apple.security.device.audio-input', 'com.apple.security.personal-information.calendars'])
  })
  it('whisper-server: nothing', () => {
    expect(keys(helperEntitlements(`${bin}/whisper-server`, build))).toEqual([])
  })
  it("Electron's own files keep electron-builder's choice; an unknown helper is an error", () => {
    expect(helperEntitlements('/x/Yogurt.app/Contents/Frameworks/Yogurt Helper.app', build)).toBeNull()
    expect(() => helperEntitlements(`${bin}/something-new`, build)).toThrow(/something-new/)
  })
})

it("the app and Electron's helpers never get more than they need", () => {
  expect(keys(join(build, 'entitlements.mac.inherit.plist'))).toEqual(['com.apple.security.cs.allow-jit'])
  expect(keys(join(build, 'entitlements.mac.plist'))).not.toContain('com.apple.security.cs.disable-library-validation')
})

describe('signing tries again, like electron-builder does', () => {
  it('up to 3 tries, 5 s apart; the last error stands', async () => {
    // @ts-expect-error plain script, no types
    const { retry } = await import('../scripts/sign.cjs')
    const waits: number[] = []
    const sleep = async (ms: number) => { waits.push(ms) }
    let n = 0
    await expect(retry(async () => { n++; if (n < 3) throw new Error('timestamp server busy'); return 'signed' }, sleep)).resolves.toBe('signed')
    expect(n).toBe(3)
    expect(waits).toEqual([5000, 5000])
    n = 0
    await expect(retry(async () => { n++; throw new Error(`no ${n}`) }, sleep)).rejects.toThrow('no 3')
    expect(n).toBe(3)
  })
})


it('local signing disables timestamps for every file; release signing keeps its timestamp options', async () => {
  const require = createRequire(import.meta.url)
  const osx = require('@electron/osx-sign')
  const sign = require('../scripts/sign.cjs')
  const signed = vi.spyOn(osx, 'signAsync').mockResolvedValue(undefined)
  try {
    const options = { identity: 'certificate', optionsForFile: (_file: string) => ({ timestamp: 'release-server', hardenedRuntime: true }) }
    vi.stubEnv('YOGURT_SIGN_ID', 'Yogurt Local'); vi.stubEnv('YOGURT_NOTARIZE', '0')
    await sign(options)
    const local = signed.mock.calls[0][0] as typeof options
    for (const file of [`${bin}/yogurt-audio`, '/x/Yogurt.app/Contents/Frameworks/file']) {
      expect(local.optionsForFile(file)).toMatchObject({ timestamp: 'none', hardenedRuntime: true })
    }
    vi.stubEnv('YOGURT_SIGN_ID', 'Developer ID')
    await sign(options)
    const release = signed.mock.calls[1][0] as typeof options
    expect(release.optionsForFile('/x/Yogurt.app')).toMatchObject({ timestamp: 'release-server', hardenedRuntime: true })
  } finally { signed.mockRestore(); vi.unstubAllEnvs() }
})
