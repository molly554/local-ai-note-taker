import { useEffect, useState } from 'react'
import { cubicBezier } from 'motion'
import { followMotion } from '../../shared/follow'

const REDUCED = '(prefers-reduced-motion: reduce)'
const SETTLE = [.16, .8, .25, 1] as const

/** One stretch and settle on opening surfaces. Reading content never scales or blurs. */
export const surfaceMotion = {
  pullMs: 260,
  settleMs: 280,
  exitMs: 160,
  exitHoldMs: 180,
  pullEase: 'cubic-bezier(.18,.8,.25,1)',
  settleEase: `cubic-bezier(${SETTLE.join(',')})`,
  releaseEase: 'cubic-bezier(.2,0,.25,1)',
  settleAt: 0.72,
} as const

/** Scripted scrolling respects the same system preference as CSS motion. Read it at use time. */
export const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia(REDUCED).matches ? 'auto' : 'smooth'

/** The system's reduced-motion setting, followed live */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED).matches)
  useEffect(() => {
    const q = window.matchMedia(REDUCED)
    const on = () => setReduced(q.matches)
    q.addEventListener('change', on)
    on() // A preference may have changed between render and subscribing.
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Scrolls `el` to `top` over a moment, frame by frame, and returns a way to stop it. The browser's own smooth scroll
 * can't be stopped, and one that starts as a person turns the wheel swallows their scroll. Jumps with reduced motion.
 */
export function glide(el: HTMLElement, top: number, done: () => void, ms = 240): () => void {
  if (scrollBehavior() === 'auto') { el.scrollTop = top; done(); return () => {} }
  const from = el.scrollTop, t0 = performance.now()
  let frame = 0
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms)
    el.scrollTop = from + (top - from) * (1 - (1 - p) ** 3)
    if (p < 1) frame = requestAnimationFrame(step)
    else done()
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

/** One frame loop takes the latest seek; earlier motion keeps its momentum until the final target settles. */
export function followGlide(el: HTMLElement, done: () => void) {
  const motion = followMotion(el.scrollTop, surfaceMotion.settleMs, cubicBezier(...SETTLE))
  let target = el.scrollTop, frame = 0
  const step = (now: number) => {
    frame = 0
    if (scrollBehavior() === 'auto') { el.scrollTop = target; done(); return }
    motion.to(target, now)
    el.scrollTop = motion.at(now)
    if (motion.active) frame = requestAnimationFrame(step)
    else done()
  }
  return {
    to(top: number) { target = top; if (!frame) frame = requestAnimationFrame(step) },
    stop() { cancelAnimationFrame(frame); frame = 0 },
    get active() { return frame !== 0 },
  }
}
