import { describe, expect, it } from 'vitest'
import { barPlan, frameKey, micLevel, Wave } from '../src/shared/wave'

describe('microphone meter', () => {
  it('keeps silence quiet and makes ordinary speech visible without using call audio', () => {
    expect(micLevel({ me: 0, them: 1 })).toBe(0)
    expect(micLevel({ me: .15, them: 1 })).toBe(0)
    const speech = [-40, -25, -12].map(db => micLevel({ me: (db + 60) / 60, them: 0 }))
    expect(speech[0]).toBeGreaterThan(.25)
    expect(speech[1]).toBeGreaterThan(.6)
    expect(speech[2]).toBe(1)
    expect(micLevel({ me: Infinity, them: 0 })).toBe(0)
    expect(micLevel({ me: -1, them: 0 })).toBe(0)
    expect(micLevel({ me: 2, them: 0 })).toBe(1)
  })
  it('attacks in 60ms and releases in 220ms without a scrolling delay', () => {
    const w = new Wave()
    w.target = 1; w.step(60)
    expect(w.level).toBeCloseTo(1 - Math.exp(-1))
    const peak = w.level
    w.target = 0; w.step(60)
    expect(w.level).toBeGreaterThan(peak * .75)
    w.step(2000)
    expect(w.level).toBeLessThan(.001)
  })
  it('draws five symmetric bars with a tall center, and five quiet dots at rest', () => {
    expect(barPlan({ level: 1, reduced: false, paused: false }).heights).toEqual([.5, .75, 1, .75, .5])
    const quiet = barPlan({ level: 0, reduced: false, paused: false })
    expect(quiet.heights).toEqual([0, 0, 0, 0, 0])
    expect(quiet.alpha.every(a => a > 0 && a < .6)).toBe(true)
  })
  it('fits the note control in three bars while preserving the live center and quiet pause', () => {
    expect(barPlan({ level: 1, reduced: false, paused: false, bars: 3 }).heights).toEqual([.75, 1, .75])
    expect(barPlan({ level: 1, reduced: false, paused: true, bars: 3 }).heights).toEqual([0, 0, 0])
  })
  it('reduced motion and pause stay three static dots regardless of live levels', () => {
    for (const reduced of [false, true]) for (const paused of [false, true]) {
      if (!reduced && !paused) continue
      const rest = barPlan({ level: 0, reduced, paused })
      expect(rest.heights).toEqual([0, 0, 0])
      expect(barPlan({ level: 1, reduced, paused })).toEqual(rest)
    }
  })
  it('a frame that would draw the same pixels is the same frame, so it is not drawn again', () => {
    const at = (level: number) => frameKey(barPlan({ level, reduced: false, paused: false }), 16)
    expect(at(.5)).toBe(at(.5001))
    expect(at(0)).toBe(at(.0004))
    expect(at(.5)).not.toBe(at(.6))
    // the bars fade in with the level even before they grow a pixel
    expect(at(0)).not.toBe(at(.02))
  })
  it('the meter settles at silence, and only then may its loop sleep', () => {
    const w = new Wave()
    expect(w.settled()).toBe(true)
    w.target = 1; w.step(60)
    expect(w.settled()).toBe(false)
    w.target = 0; w.step(60)
    expect(w.settled()).toBe(false)
    w.step(2000)
    expect(w.settled()).toBe(true)
    expect(w.level).toBe(0)
  })
})
