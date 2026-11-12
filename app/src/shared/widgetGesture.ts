export type WidgetPress = { x: number; y: number; pointerId: number; at: number; moved: boolean }

/** Keep the origin until movement reaches four pixels; once dragging, never turn back into a click. */
export function widgetDragDelta(press: WidgetPress, x: number, y: number) {
  const dx = x - press.x, dy = y - press.y
  if (!press.moved && Math.max(Math.abs(dx), Math.abs(dy)) < 4) return null
  press.moved = true; press.x = x; press.y = y
  return { dx, dy }
}

/** A stationary hold is not a click, and release may carry movement missed between pointer events. */
export function isWidgetClick(press: WidgetPress, x: number, y: number, at: number) {
  return !press.moved && at - press.at < 400 && Math.max(Math.abs(x - press.x), Math.abs(y - press.y)) < 4
}
