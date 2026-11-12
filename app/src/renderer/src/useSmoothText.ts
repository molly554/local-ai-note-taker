import { useEffect, useRef, useState } from 'react'
import { stillShown, TextSmoother } from '../../shared/smoothText'
import { useReducedMotion } from './motion'

/**
 * Text that streams in, revealed smoothly a few characters a frame (see `TextSmoother`): every place Yogurt shows
 * words as they are written uses this, with the `.stream-caret` dot after the last word while `live`. Once `live`
 * turns false the full text is returned at once, so the end is never held back.
 * - `minCommitMs`: draw at most this often (a heavy view, like the notes editor, needn't redraw every frame)
 * - `startShown`: text already there when the view opens shows in full; only what arrives afterwards unrolls
 */
export function useSmoothText(text: string, live: boolean, opts: { minCommitMs?: number; startShown?: boolean } = {}): string {
  const reduced = useReducedMotion()
  const smooth = live && !reduced
  const [smoother] = useState(() => new TextSmoother(text, smooth && !opts.startShown))
  const [shown, setShown] = useState(smoother.shown)
  const minCommitMs = useRef(opts.minCommitMs ?? 0)
  minCommitMs.current = opts.minCommitMs ?? 0

  useEffect(() => {
    smoother.update(text, smooth, performance.now())
    setShown(smoother.shown)
    if (smoother.settled) return
    let frame = 0, drawn = performance.now()
    const step = (now: number) => {
      smoother.tick(now)
      if (smoother.settled || now - drawn >= minCommitMs.current) { drawn = now; setShown(smoother.shown) }
      if (!smoother.settled) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [smoother, text, smooth])

  // not streaming (ended, stopped, reduced motion): the real text, this very render
  return smooth ? stillShown(shown, text) : text
}
