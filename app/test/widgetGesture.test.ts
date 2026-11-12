import { expect, it } from 'vitest'
import { widgetDragDelta, isWidgetClick, type WidgetPress } from '../src/shared/widgetGesture'

const press = (): WidgetPress => ({ x: 100, y: 100, pointerId: 1, at: 1000, moved: false })

it('opens only a short click within the movement threshold', () => {
  const p = press()
  expect(widgetDragDelta(p, 102, 102)).toBeNull()
  expect(isWidgetClick(p, 102, 102, 1150)).toBe(true)
  expect(isWidgetClick(p, 100, 100, 1400)).toBe(false)
  expect(isWidgetClick(p, 100, 100, 5000)).toBe(false)
})

it('drags immediately at four pixels, including after a hold, and never opens on release', () => {
  const p = press()
  expect(widgetDragDelta(p, 104, 100)).toEqual({ dx: 4, dy: 0 })
  expect(widgetDragDelta(p, 101, 98)).toEqual({ dx: -3, dy: -2 })
  expect(widgetDragDelta(p, 100, 100)).toEqual({ dx: -1, dy: 2 })
  expect(isWidgetClick(p, 100, 100, 1100)).toBe(false)
  const held = press()
  expect(isWidgetClick(held, 100, 100, 2000)).toBe(false)
  expect(widgetDragDelta(held, 110, 120)).toEqual({ dx: 10, dy: 20 })
})

it('rejects movement seen only at release and accumulates sub-threshold moves', () => {
  const p = press()
  expect(isWidgetClick(p, 105, 100, 1100)).toBe(false)
  expect(widgetDragDelta(p, 102, 100)).toBeNull()
  expect(widgetDragDelta(p, 103, 100)).toBeNull()
  expect(widgetDragDelta(p, 104, 100)).toEqual({ dx: 4, dy: 0 })
})
