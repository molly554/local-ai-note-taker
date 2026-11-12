import { describe, expect, it } from 'vitest'
import { followMotion, followTarget, inView } from '../src/shared/follow'

// a list 300 px tall, 3000 px of lines
const view = (scrollTop: number) => ({ scrollTop, height: 300, scrollHeight: 3000 })
const row = (top: number, height = 24) => ({ top, bottom: top + height })

describe('inView', () => {
  it('is true while any of the line shows', () => {
    expect(inView(row(400), view(300))).toBe(true)
    expect(inView(row(290), view(300))).toBe(true)
    expect(inView(row(590), view(300))).toBe(true)
  })
  it('is false once the line is wholly above or below', () => {
    expect(inView(row(200), view(300))).toBe(false)
    expect(inView(row(600), view(300))).toBe(false)
  })
})

describe('followTarget', () => {
  it('leaves the list alone while the line sits comfortably in view', () => {
    expect(followTarget(row(400), view(300))).toBeNull()
    expect(followTarget(row(340), view(300))).toBeNull()
  })
  it('moves a line nearing the bottom edge up to a third of the way down', () => {
    // 550 is in the bottom third (500..600)
    expect(followTarget(row(550), view(300))).toBe(450)
  })
  it('brings a line out of sight below or above into the middle third', () => {
    expect(followTarget(row(1200), view(300))).toBe(1100)
    expect(followTarget(row(100), view(300))).toBe(0)
    expect(followTarget(row(250), view(300))).toBe(150)
  })
  it('brings a line hugging the top edge down a little', () => {
    expect(followTarget(row(305), view(300))).toBe(205)
  })
  it('never scrolls past the end of the list', () => {
    expect(followTarget(row(2950), view(2500))).toBe(2700)
  })
  it('always places the line a third of the way down when asked to', () => {
    expect(followTarget(row(400), view(300), true)).toBe(300)
    expect(followTarget(row(420), view(300), true)).toBe(320)
  })
})

describe('followMotion', () => {
  const ease = (p: number) => 1 - (1 - p) ** 3
  it('retargets without jumping or restarting the motion already in flight', () => {
    const motion = followMotion(0, 280, ease)
    motion.to(1000, 0)
    const at = motion.at(80)
    motion.to(1500, 80)
    expect(motion.at(80)).toBe(at)
    expect(motion.at(160)).toBeCloseTo(1000 * ease(160 / 280) + 500 * ease(80 / 280))
    expect(motion.active).toBe(true)
    expect(motion.at(360)).toBe(1500)
    expect(motion.active).toBe(false)
  })
  it('follows a reversing drag continuously and settles at the last target', () => {
    const motion = followMotion(800, 280, ease)
    motion.to(1600, 0)
    const at = motion.at(100)
    motion.to(200, 100)
    expect(motion.at(100)).toBe(at)
    for (let now = 116; now < 380; now += 16) {
      const top = motion.at(now)
      expect(top).toBeGreaterThanOrEqual(200)
      expect(top).toBeLessThanOrEqual(1600)
    }
    expect(motion.at(380)).toBe(200)
    expect(motion.at(1000)).toBe(200)
  })
})
