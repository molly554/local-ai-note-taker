import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMotion, DROPS, firmAt, flight, LAP, LAST_HOME, setReal, shapeAt, stepMotion, type BlobMotion } from '../src/shared/downloadBlob'
import { fakeDownloadDeps } from '../src/main/fake'
const frame = 1 / 60
function inspect(m: BlobMotion) {
  const s = shapeAt(m)
  if (s.drops.some(d => d.r > 0)) { expect(s.firm).toBeLessThanOrEqual(.8); expect(s.rim).toBe(0); expect(m.setStartedAt).toBeNull() }
  if (s.rim > 0) { expect(m.real).toBe(1); expect(m.home.every(Boolean)).toBe(true) }
  return s
}
it('starts at rest, launches singly over 3.4 seconds and flies continuously below each threshold', () => {
  const m = createMotion()
  stepMotion(m, 20)
  expect(m.time).toBe(0); expect(shapeAt(m).drops.every(d => d.r === 0)).toBe(true)
  setReal(m, .01)
  for (let i = 0; i < 21 * 60; i++) {
    stepMotion(m, frame)
    const s = inspect(m)
    expect(s.drops.filter(d => d.r > 0)).toHaveLength(DROPS.filter(d => m.time > d.launch).length)
    expect(m.home.every(h => !h)).toBe(true)
  }
  flight(.5).forEach((v, i) => expect(v).toBeCloseTo(flight(.5 + LAP)[i]))
  for (let t = 0; t < LAP; t += .01) {
    const a = flight(t), b = flight(t + .001)
    expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / .001).toBeGreaterThan(23)
  }
})
it('uses the six exact thresholds, retiring only inside on the next eligible return', () => {
  expect(DROPS.map(d => d.threshold)).toEqual([.3, .55, .75, .88, .92, .965])
  for (const [i, drop] of DROPS.entries()) {
    const m = createMotion()
    setReal(m, drop.threshold - .001)
    for (let t = 0; t < 16; t += frame) stepMotion(m, frame)
    expect(m.home[i]).toBe(false)
    setReal(m, drop.threshold)
    for (let t = 0; t < 7; t += frame) { stepMotion(m, frame); inspect(m) }
    expect(m.home[i]).toBe(true)
    expect(m.landings.find(l => l.drop === i + 1)!.waitSeconds).toBeLessThanOrEqual(LAP + frame)
    for (let phase = drop.merge; phase < LAP; phase += .01) {
      const [x, y] = flight(phase)
      expect(Math.hypot(x, y) + drop.r).toBeLessThan(43)
    }
  }
})
it('caps displayed progress and requires both real completion and all merges before the 800ms set', () => {
  const m = createMotion()
  setReal(m, 1); stepMotion(m, frame)
  expect(m.shown).toBeLessThanOrEqual(.3 * frame)
  expect(inspect(m).firm).toBeLessThanOrEqual(.8)
  for (let t = 0; t < 15 && m.setStartedAt === null; t += frame) { stepMotion(m, frame); inspect(m) }
  expect(m.shown).toBe(LAST_HOME); expect(m.home.every(Boolean)).toBe(true)
  stepMotion(m, .4); expect(shapeAt(m).firm).toBeCloseTo(.9)
  stepMotion(m, .4); expect(shapeAt(m)).toMatchObject({ firm: 1, rim: 1, blur: 0, cornerExtra: 0 })
  const stalled = createMotion(.965)
  for (let t = 0; t < 20; t += frame) stepMotion(stalled, frame)
  expect(stalled.home.every(Boolean)).toBe(true); expect(stalled.setStartedAt).toBeNull(); expect(shapeAt(stalled).rim).toBe(0)
})
it('firms cubically from 70%, stays soft at the last threshold, and reduced motion is always crisp', () => {
  expect(firmAt(.7)).toBe(0); expect(firmAt(.85)).toBeCloseTo(((.85 - .7) / .265) ** 3)
  const m = createMotion(1)
  expect(shapeAt(m)).toMatchObject({ firm: .8, rim: 0, blur: 1.2 })
  expect(shapeAt(m, true)).toMatchObject({ firm: 1, rim: 1, blur: 0, cornerExtra: 0, scaleX: 1, scaleY: 1, angle: 0 })
  expect(shapeAt(m, true).drops.every(d => d.r === 0)).toBe(true)
  setReal(m, 0); expect(shapeAt(m).drops.every(d => d.r === 0)).toBe(true)
})
it('handles the real fake-mode download steps over 45 seconds without changing lap speed', async () => {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-blob-fake-')), events: { at: number; fraction: number }[] = []
  const began = Date.now()
  try {
    const run = fakeDownloadDeps({ stepMs: 11_250 }).download('fixture', dir, 'model', p => events.push({ at: (Date.now() - began) / 1000, fraction: p.fraction }), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(45_000); await run
    expect(events.map(e => e.at)).toEqual([0, 11.25, 22.5, 33.75])
    const m = createMotion()
    for (let t = 0; t < 45; t += frame) {
      setReal(m, events.filter(e => e.at <= t).at(-1)!.fraction)
      stepMotion(m, frame); inspect(m)
    }
    expect(m.shown).toBe(1); expect(m.landings).toHaveLength(6)
    expect(LAP).toBe(6)
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
})

it('lands at a crossed rejoin even when a renderer stall skips its inside interval', () => {
  const m = createMotion(.3)
  for (let i = 0; i < 324; i++) stepMotion(m, frame)
  expect(m.home[0]).toBe(false)
  stepMotion(m, .8)
  expect(m.home[0]).toBe(true)
  expect(shapeAt(m).drops[0].r).toBe(0)
})
