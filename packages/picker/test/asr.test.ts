import { describe, expect, it } from 'vitest'
import { asrCandidates, KEEPS_UP_RTF, pickAsr, pickBySpeed, speedKey } from '../src/asr'
import { machines } from './fixtures'
import real from '../../../catalog/catalog.json'
import type { Catalog } from '../src/types'

const catalog = real as unknown as Catalog

describe('pickAsr', () => {
  it('turbo on a 32 GB Mac', () => {
    expect(pickAsr(machines.m1max32, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
  })
  it('turbo on an 8 GB Mac (the notes model never runs while recording)', () => {
    expect(pickAsr(machines.mac8, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
  })
  it('turbo on 16 GB and 128 GB', () => {
    expect(pickAsr(machines.m3air16, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
    expect(pickAsr(machines.m4max128, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
  })
  it('small on a machine with under 8 GB', () => {
    expect(pickAsr({ ...machines.mac8, totalRamGB: 6 }, catalog).model.id).toBe('whisper-small-q5_1')
  })
  it('names small as the fallback when turbo is picked', () => {
    expect(pickAsr(machines.m1max32, catalog).fallback?.id).toBe('whisper-small-q5_1')
    expect(pickAsr({ ...machines.mac8, totalRamGB: 6 }, catalog).fallback).toBeUndefined()
  })
  it('skips a model that failed verification', () => {
    expect(pickAsr(machines.m1max32, catalog, { exclude: ['whisper-large-v3-turbo-q5_0'] }).model.id).toBe('whisper-small-q5_1')
  })
})

describe('pickAsr without graphics (Windows and Linux)', () => {
  it('Whisper small on the processor alone: turbo is too slow to keep up there', () => {
    expect(pickAsr(machines.winLaptop8, catalog).model.id).toBe('whisper-small-q5_1')
    expect(pickAsr({ ...machines.winLaptop8, totalRamGB: 32 }, catalog).model.id).toBe('whisper-small-q5_1')
  })
  it('turbo with a graphics card', () => {
    expect(pickAsr(machines.linux3060, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
  })
})

describe('the measured speed check (Windows and Linux)', () => {
  const ids = (l: { id: string }[]) => l.map((a) => a.id)
  it('a Mac never sees the last-resort models: its pick and fallback are exactly as before', () => {
    for (const m of [machines.m1max32, machines.mac8, machines.m3air16, machines.m4max128]) {
      expect(pickAsr(m, catalog).model.id).toBe('whisper-large-v3-turbo-q5_0')
      expect(pickAsr(m, catalog).fallback?.id).toBe('whisper-small-q5_1')
    }
    expect(pickAsr(machines.m1max32, catalog, { exclude: ['whisper-large-v3-turbo-q5_0', 'whisper-small-q5_1'] }).model.id).not.toMatch(/tiny|base/)
    expect(asrCandidates(machines.m1max32, catalog)).toEqual([])
  })
  it('with graphics: turbo first, then down to the smallest', () => {
    expect(ids(asrCandidates(machines.linux3060, catalog))).toEqual(['whisper-large-v3-turbo-q5_0', 'whisper-small-q5_1', 'whisper-base-q5_1', 'whisper-tiny-q5_1'])
  })
  it('on the processor alone turbo is never tried (it measured 4 to 9 times too slow)', () => {
    expect(ids(asrCandidates(machines.winLaptop8, catalog))).toEqual(['whisper-small-q5_1', 'whisper-base-q5_1', 'whisper-tiny-q5_1'])
  })
  it('leaves out models that failed verification', () => {
    expect(ids(asrCandidates(machines.winLaptop8, catalog, { exclude: ['whisper-small-q5_1'] }))).toEqual(['whisper-base-q5_1', 'whisper-tiny-q5_1'])
  })
  it('every model is pinned with a sha256', () => {
    for (const a of catalog.asr) expect(a.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('pickBySpeed', () => {
  const list = [{ id: 'turbo' }, { id: 'small' }, { id: 'base' }, { id: 'tiny' }]
  const timed = (rtf: Record<string, number | null>) => { const asked: string[] = []; return { asked, measure: async (m: { id: string }) => { asked.push(m.id); return rtf[m.id] } } }
  it('keeps the first (best) model that reads a clip in half its length or less, and times nothing smaller', async () => {
    const t = timed({ turbo: 0.12 })
    expect(await pickBySpeed(list, t.measure)).toEqual({ model: list[0], rtf: { turbo: 0.12 } })
    expect(t.asked).toEqual(['turbo'])
  })
  it('falls back down the list until one keeps up; exactly 0.5 still does', async () => {
    const t = timed({ turbo: 4.4, small: 0.88, base: 0.5 })
    expect(await pickBySpeed(list, t.measure)).toEqual({ model: list[2], rtf: { turbo: 4.4, small: 0.88, base: 0.5 } })
    expect(KEEPS_UP_RTF).toBe(0.5)
  })
  it('a run that ran out of time counts as too slow', async () => {
    const t = timed({ turbo: null, small: null, base: null, tiny: 0.19 })
    expect((await pickBySpeed(list, t.measure)).model).toBe(list[3])
  })
  it('none keeps up: no model, with every time it measured', async () => {
    const t = timed({ turbo: 9, small: 2, base: 1.1, tiny: 0.6 })
    expect(await pickBySpeed(list, t.measure)).toEqual({ model: null, rtf: { turbo: 9, small: 2, base: 1.1, tiny: 0.6 } })
  })
})

describe('speedKey: the speed check runs again only when the computer changes', () => {
  it('the same computer gives the same key; other graphics or processor a new one', () => {
    const k = speedKey(machines.linux3060)
    expect(speedKey({ ...machines.linux3060, freeDiskGB: 1 })).toBe(k)
    expect(speedKey({ ...machines.linux3060, gpu: { kind: 'none', name: '', vramGB: 0 } })).not.toBe(k)
    expect(speedKey({ ...machines.linux3060, gpu: { ...machines.linux3060.gpu, name: 'NVIDIA GeForce RTX 4070' } })).not.toBe(k)
    expect(speedKey({ ...machines.linux3060, cpuModel: 'AMD Ryzen 7 7700' })).not.toBe(k)
    expect(speedKey({ ...machines.linux3060, cores: 6 })).not.toBe(speedKey({ ...machines.linux3060, cores: 12 }))
  })
})
