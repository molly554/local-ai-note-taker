import { afterEach, describe, expect, it, vi } from 'vitest'
import { followGlide, surfaceMotion } from '../src/renderer/src/motion'

afterEach(() => vi.unstubAllGlobals())

function frames(reduced = false) {
  let next = 0
  const pending = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending.set(++next, cb); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
  return { pending, at(now: number) { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(now)) } }
}

describe('playhead scroll frames', () => {
  it('coalesces seeks, keeps one frame loop, and settles after the final drag event', () => {
    const clock = frames(), done = vi.fn(), el = { scrollTop: 0 } as HTMLElement
    const glide = followGlide(el, done)
    glide.to(100); glide.to(400); glide.to(1000)
    expect(clock.pending.size).toBe(1)
    clock.at(0)
    expect(el.scrollTop).toBe(0)
    clock.at(100)
    const first = el.scrollTop
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(1000)
    glide.to(2000); glide.to(1500)
    clock.at(116)
    expect(el.scrollTop).toBeGreaterThan(first)
    expect(el.scrollTop).toBeLessThan(1000)
    expect(clock.pending.size).toBe(1)
    clock.at(116 + surfaceMotion.settleMs)
    expect(el.scrollTop).toBe(1500)
    expect(clock.pending.size).toBe(0)
    expect(done).toHaveBeenCalledOnce()
    expect(glide.active).toBe(false)
  })
  it('a manual scroll cancels the pending frame and cannot be pulled back later', () => {
    const clock = frames(), el = { scrollTop: 0 } as HTMLElement, done = vi.fn()
    const glide = followGlide(el, done)
    glide.to(1000); clock.at(0); clock.at(80)
    glide.stop(); el.scrollTop = 50
    clock.at(1000)
    expect(el.scrollTop).toBe(50)
    expect(done).not.toHaveBeenCalled()
    expect(clock.pending.size).toBe(0)
  })
  it('reduced motion jumps to the latest seek in one frame without a settling loop', () => {
    const clock = frames(true), el = { scrollTop: 0 } as HTMLElement, done = vi.fn()
    const glide = followGlide(el, done)
    glide.to(1000); glide.to(500); clock.at(0)
    expect(el.scrollTop).toBe(500)
    expect(clock.pending.size).toBe(0)
    expect(done).toHaveBeenCalledOnce()
  })
})
