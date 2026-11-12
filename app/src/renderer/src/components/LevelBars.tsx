import { useEffect, useRef } from 'react'
import { barPlan, frameKey, micLevel, Wave } from '../../../shared/wave'

const BAR_W = 3, GAP = 3

const reducedQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)')

/** Shared live microphone meter, drawn without React renders; no simulated movement. */
export function LevelBars({ height, className, testId, paused = false, bars = 5 }: { height: number; bars?: 3 | 5; className?: string; testId: string; paused?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = bars * BAR_W + (bars - 1) * GAP
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wave = new Wave()
    const mq = reducedQuery()
    const dpr = window.devicePixelRatio || 1
    let reduced = mq.matches
    c.width = width * dpr; c.height = height * dpr
    // read once (and again when the theme changes), not every frame: getComputedStyle forces a style pass
    let color = getComputedStyle(c).color
    let drawn = ''
    const draw = (force = false) => {
      const ctx = c.getContext('2d')
      if (!ctx) return
      const plan = barPlan({ reduced, paused, level: wave.level, bars })
      // the same pixels as the last frame: nothing new for the compositor
      const key = frameKey(plan, height - BAR_W)
      if (!force && key === drawn) return
      drawn = key
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = color
      plan.heights.forEach((v, i) => {
        const h = BAR_W + Math.round(v * (height - BAR_W))
        ctx.globalAlpha = plan.alpha[i]
        ctx.beginPath()
        const inset = (width - plan.heights.length * BAR_W - (plan.heights.length - 1) * GAP) / 2
        ctx.roundRect(inset + i * (BAR_W + GAP), (height - h) / 2, BAR_W, h, BAR_W / 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
      c.dataset.level = wave.level.toFixed(2)
    }
    let levelAt = performance.now()
    const off = window.yogurt.widget.onLevel((lv) => {
      wave.target = micLevel(lv); levelAt = performance.now()
      if (reduced) { wave.level = wave.target; draw() } else if (wave.target > 0) wake()
    })
    let raf = 0, last = performance.now()
    // tests read whether the loop runs; set only when that changes
    const live = (on: boolean) => { if (!on) { cancelAnimationFrame(raf); raf = 0 } c.dataset.live = on ? '1' : '0' }
    const frame = (now: number) => {
      const dt = Math.min(100, now - last); last = now
      if (now - levelAt > 300) wave.target = 0
      wave.step(dt)
      // at rest in silence the loop sleeps until the next level wakes it
      if (wave.settled()) { draw(true); live(false); return }
      draw()
      raf = requestAnimationFrame(frame)
    }
    const start = () => { last = performance.now(); raf = requestAnimationFrame(frame); live(true) }
    // nothing runs where it can't be seen: a hidden or covered window, reduced motion, a pause
    const wake = () => { if (!raf && !reduced && !paused && document.visibilityState === 'visible') start() }
    // either way something is drawn right away
    const sync = () => {
      live(false)
      if (!reduced && !paused && document.visibilityState === 'visible') start()
      draw(true)
    }
    const onReduced = () => { reduced = mq.matches; sync() }
    const onVisible = () => { if (document.visibilityState === 'visible') wake(); else live(false) }
    const onScheme = () => { color = getComputedStyle(c).color; draw(true) }
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onReduced)
    scheme.addEventListener('change', onScheme)
    document.addEventListener('visibilitychange', onVisible)
    sync()
    return () => { off(); cancelAnimationFrame(raf); mq.removeEventListener('change', onReduced); scheme.removeEventListener('change', onScheme); document.removeEventListener('visibilitychange', onVisible) }
  }, [height, width, paused, bars])
  return <canvas ref={canvas} data-testid={testId} aria-hidden="true" className={className} style={{ width, height }} />
}
