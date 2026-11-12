/** m:ss, or h:mm:ss past an hour */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const sec = String(s % 60).padStart(2, '0')
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const ATTACK_MS = 60, RELEASE_MS = 220

/** Smooth the 10 Hz capture feed without delaying it behind a scrolling history. */
export class Wave {
  target = 0
  level = 0
  step(dtMs: number) {
    const tau = this.target > this.level ? ATTACK_MS : RELEASE_MS
    this.level += (this.target - this.level) * (1 - Math.exp(-dtMs / tau))
  }
  /** back at rest in silence (snapped to 0): nothing moves until the next level */
  settled(): boolean {
    if (this.target !== 0 || this.level >= 0.002) return false
    this.level = 0
    return true
  }
}

/** Five-bar silhouette; pause and reduced motion are three still dots. */
export function barPlan(p: { reduced: boolean; paused: boolean; level: number; bars?: 3 | 5 }): { heights: number[]; alpha: number[] } {
  if (p.paused || p.reduced) return { heights: [0, 0, 0], alpha: [0.5, 0.5, 0.5] }
  const weights = p.bars === 3 ? [.75, 1, .75] : [.5, .75, 1, .75, .5]
  return { heights: weights.map(v => v * p.level), alpha: weights.map(() => .45 + .55 * p.level) }
}

/** What a frame puts on screen, in whole pixels of growth and 1% steps of alpha: the same key draws the same pixels. */
export const frameKey = (plan: { heights: number[]; alpha: number[] }, span: number): string =>
  plan.heights.map((v) => Math.round(v * span)).join() + '|' + Math.round(plan.alpha[0] * 100)

/** Capture maps -60..0 dBFS to 0..1; show -51..-12 dBFS across the meter's range. */
export const micLevel = (lv: { me: number; them: number }): number => Number.isFinite(lv.me) ? Math.max(0, Math.min(1, (lv.me - .15) / .65)) : 0
