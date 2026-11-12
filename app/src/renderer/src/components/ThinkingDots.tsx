import { useEffect, useRef } from 'react'
import { softPairAlpha } from '../../../shared/softPair'
import { useReducedMotion } from '../motion'

/** Soft pair while AI reads; static three dots when movement is reduced. */
export function ThinkingDots() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || reduced) return
    const pixels = ctx.createImageData(72, 80)
    let frame = 0, last = -Infinity, visible = false
    const draw = (now: number) => {
      if (!el.isConnected) return // A stream can remove the canvas before effect cleanup cancels this frame.
      if (now - last >= 1000 / 30) {
        last = now
        const rgb = getComputedStyle(el).color.match(/[\d.]+/g)!.map(Number)
        for (let y = 0; y < 80; y++) for (let x = 0; x < 72; x++) {
          const i = (y * 72 + x) * 4
          pixels.data[i] = rgb[0]; pixels.data[i + 1] = rgb[1]; pixels.data[i + 2] = rgb[2]
          pixels.data[i + 3] = softPairAlpha((x + .5) / 4, (y + .5) / 4, (now % 2800) / 2800)
        }
        ctx.putImageData(pixels, 0, 0)
      }
      frame = requestAnimationFrame(draw)
    }
    const sync = () => {
      cancelAnimationFrame(frame)
      if (visible && !document.hidden) frame = requestAnimationFrame(draw)
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync() })
    observer.observe(el)
    document.addEventListener('visibilitychange', sync)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', sync) }
  }, [reduced])
  return reduced
    ? <span className="thinking-dots thinking-dots-static" data-testid="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
    : <canvas ref={canvas} width={72} height={80} className="thinking-dots" data-testid="thinking-dots" aria-hidden="true" />
}
