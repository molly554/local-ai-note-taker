/** Where a line sits in the list's content, and the list's scroll, in pixels */
type Box = { top: number; bottom: number }
type View = { scrollTop: number; height: number; scrollHeight: number }

/** this far from the top still reads as cut off, as a share of the list's height */
const TOP_MARGIN = 0.1
/** past this share of the list's height, the line is too close to the bottom edge */
const LOW_EDGE = 2 / 3
/** a moved line lands this far down, so what comes next shows below it */
const LAND_AT = 1 / 3

/** Whether any of the line shows */
export function inView(row: Box, v: View): boolean {
  return row.bottom > v.scrollTop && row.top < v.scrollTop + v.height
}

/**
 * Where to scroll so the line being played stays comfortably in view: null while it sits between a little below the top
 * and two thirds of the way down, else a third of the way down (clamped to the list). `always` moves it there anyway.
 */
export function followTarget(row: Box, v: View, always = false): number | null {
  const comfy = row.top >= v.scrollTop + v.height * TOP_MARGIN && row.bottom <= v.scrollTop + v.height * LOW_EDGE
  if (comfy && !always) return null
  return Math.round(Math.max(0, Math.min(v.scrollHeight - v.height, row.top - v.height * LAND_AT)))
}

/** Each change carries on settling when the playhead moves again, instead of restarting the scroll. */
export function followMotion(from: number, duration: number, ease: (progress: number) => number) {
  let settled = from, target = from
  let moves: Array<{ delta: number; start: number }> = []
  return {
    to(next: number, now: number) {
      if (next !== target) moves.push({ delta: next - target, start: now })
      target = next
    },
    at(now: number) {
      let moving = 0
      moves = moves.filter(({ delta, start }) => {
        const progress = Math.max(0, Math.min(1, (now - start) / duration))
        if (progress === 1) { settled += delta; return false }
        moving += delta * ease(progress)
        return true
      })
      return settled + moving
    },
    get active() { return moves.length > 0 },
  }
}
