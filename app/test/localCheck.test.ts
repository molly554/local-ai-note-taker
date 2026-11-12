import { describe, expect, it } from 'vitest'
import type { Hardware } from '@yogurt/picker'
import { MIN_CPU_CORES, tooSlow, tooWeak } from '../src/main/localCheck'

const pc = (o: Partial<Hardware> = {}): Hardware => ({ os: 'win32', arch: 'x64', cpuModel: 'Intel Core i5-1135G7', totalRamGB: 16, freeDiskGB: 200, gpu: { kind: 'none', name: '', vramGB: 0 }, cores: 8, ...o })

describe('too weak to run everything here', () => {
  it('a Mac keeps its words and its rule (the picker)', () => {
    const mac = pc({ os: 'darwin', gpu: { kind: 'unified', name: 'Apple M1', vramGB: 0 }, cores: 2 })
    expect(tooWeak(mac, true)).toBeNull()
    expect(tooWeak(mac, false)).toBe('Lynote NoteTaker needs a Mac with at least 8 GB of memory.')
  })
  it('Windows and Linux: no notes model that runs well is the memory sentence', () => {
    expect(tooWeak(pc(), false)).toBe("Lynote NoteTaker runs entirely on your computer, and this one isn't strong enough. It needs at least 8 GB of memory.")
  })
  it('a processor alone with under 4 cores cannot transcribe two voices as they talk, so it says so plainly (never the cloud)', () => {
    expect(tooWeak(pc({ cores: 2 }), true)).toBe("Lynote NoteTaker runs entirely on your computer, and this one can't keep up with a meeting as it happens. It needs a processor with at least 4 cores, or graphics it can use.")
    expect(tooWeak(pc({ cores: 4 }), true)).toBeNull()
    for (const kind of ['discrete', 'unified'] as const) expect(tooWeak(pc({ cores: 2, gpu: { kind, name: 'GPU', vramGB: 4 } }), true)).toBeNull()
    expect(tooWeak(pc({ cores: undefined }), true)).toBeNull()
  })
})

describe('too slow, measured (Windows and Linux)', () => {
  it("says plainly, in each computer's words, that even the smallest speech model cannot keep up, and never offers the cloud", () => {
    const win = tooSlow('win32'), linux = tooSlow('linux')
    expect(win).toBe("Lynote NoteTaker runs entirely on your computer, and this one can't write down a meeting as fast as people talk. Updating your graphics driver may help. Otherwise it needs a faster processor, or graphics it can use.")
    expect(linux).toBe("Lynote NoteTaker runs entirely on your computer, and this one can't write down a meeting as fast as people talk. Installing the driver for your graphics card may help. Otherwise it needs a faster processor, or graphics it can use.")
    for (const m of [win, linux]) expect(m).not.toMatch(/cloud|online|internet/i)
  })
  it('the core count stays a quick check before anything is measured', () => {
    expect(MIN_CPU_CORES).toBe(4)
  })
})
