import type { WidgetView } from './types'

export type WidgetRect = { x: number; y: number; width: number; height: number }
export type WidgetSurface = WidgetRect & { radius: number }
export type WidgetLayout = { bounds: WidgetRect; pill: WidgetRect; open: WidgetRect }

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** Keep the pill's corner fixed; turn inward at the display edges. */
export function widgetLayout(pill: WidgetRect, area: WidgetRect): WidgetLayout {
  const width = Math.min(340, area.width), height = Math.min(446, area.height)
  const x = clamp(pill.x + pill.width - width < area.x ? pill.x : pill.x + pill.width - width, area.x, area.x + area.width - width)
  const up = pill.y + height > area.y + area.height
  const y = clamp(up ? pill.y + pill.height - height : pill.y, area.y, area.y + area.height - height)
  // Leave room for the spring without extending beyond the display.
  const bounds = { x: Math.max(area.x, x - 8), y: Math.max(area.y, y - 8), width: 0, height: 0 }
  bounds.width = Math.min(area.x + area.width, x + width + 8) - bounds.x
  bounds.height = Math.min(area.y + area.height, y + height + 8) - bounds.y
  return { bounds, pill: { ...pill, x: pill.x - bounds.x, y: pill.y - bounds.y }, open: { x: x - bounds.x, y: y - bounds.y, width, height } }
}

export function widgetContains(rect: WidgetSurface, x: number, y: number): boolean {
  if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return false
  const radius = Math.min(rect.radius, rect.width / 2, rect.height / 2)
  const dx = x - clamp(x, rect.x + radius, rect.x + rect.width - radius)
  const dy = y - clamp(y, rect.y + radius, rect.y + rect.height - radius)
  return dx * dx + dy * dy <= radius * radius
}

export const widgetSettings = (note: WidgetView['note']) => note?.code === 'no-mic' ? 'mic' : note?.code === 'no-system-audio' ? 'systemAudio' : null

/** Hover deadlines stop during a press and wait for quiet after a drag. */
export class WidgetIntent {
  open = false
  over = false
  pressed = false
  warning = false
  quiet = 0
  due: { at: number; open: boolean } | null = null
  enter(now: number) { this.over = true; this.due = !this.pressed && !this.open ? { at: Math.max(now + 220, this.quiet), open: true } : null }
  move(now: number) { if (!this.open && !this.pressed) this.enter(now) }
  leave(now: number) { this.over = false; this.due = !this.pressed && this.open && !this.warning ? { at: Math.max(now + 480, this.quiet), open: false } : null }
  press() { this.pressed = true; this.due = null }
  release(now: number, dragged: boolean) { this.pressed = false; if (dragged) this.quiet = now + 650; this.over ? this.enter(now) : this.leave(now) }
  tick(now: number) {
    if (this.pressed) return null
    if (this.warning && !this.open) { this.open = true; this.due = null; return true }
    if (!this.due || now < this.due.at) return null
    const next = this.warning || this.due.open
    this.due = null
    if (next === this.open) return null
    this.open = next
    return next
  }
}
