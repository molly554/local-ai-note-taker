import { describe, expect, it } from 'vitest'
import { WidgetIntent, widgetContains, widgetLayout, widgetSettings } from '../src/shared/widgetMorph'
import { WidgetModel } from '../src/main/widgetModel'

describe('recorder hover intent', () => {
  it('opens after 220ms of rest and closes 480ms after leaving', () => {
    const intent = new WidgetIntent()
    intent.enter(0)
    expect(intent.tick(219)).toBeNull()
    intent.move(100)
    expect(intent.tick(319)).toBeNull()
    expect(intent.tick(320)).toBe(true)
    intent.leave(400)
    expect(intent.tick(879)).toBeNull()
    expect(intent.tick(880)).toBe(false)
  })
  it('cancels leaving on reentry and waits 650ms after a drag', () => {
    const intent = new WidgetIntent()
    intent.enter(0); intent.tick(220); intent.leave(300); intent.enter(400)
    expect(intent.tick(1000)).toBeNull()
    intent.leave(1000); intent.tick(1480)
    intent.enter(1500); intent.press()
    expect(intent.tick(2000)).toBeNull()
    intent.release(2000, true)
    expect(intent.tick(2649)).toBeNull()
    expect(intent.tick(2650)).toBe(true)
  })
  it('blocks closing during a press and post-drag quiet, including cancellation outside', () => {
    const intent = new WidgetIntent()
    intent.enter(0); intent.tick(220); intent.press(); intent.leave(300)
    expect(intent.tick(1000)).toBeNull()
    intent.release(1000, true)
    expect(intent.tick(1649)).toBeNull()
    expect(intent.tick(1650)).toBe(false)
  })
  it('shows a warning without hover and keeps it open until the warning clears', () => {
    const intent = new WidgetIntent()
    intent.warning = true
    expect(intent.tick(0)).toBe(true)
    intent.leave(100)
    expect(intent.tick(1000)).toBeNull()
    intent.warning = false; intent.leave(1000)
    expect(intent.tick(1480)).toBe(false)
  })
})

describe('recorder geometry', () => {
  const area = { x: -1200, y: -100, width: 1200, height: 900 }
  it.each([
    [-200, 0, -413, 0], [-1200, 0, -1200, 0], [-200, 750, -413, 346], [-1200, 750, -1200, 346],
  ])('keeps the pill at %s,%s and grows inward', (x, y, openX, openY) => {
    const pill = { x, y, width: 127, height: 42 }, result = widgetLayout(pill, area)
    expect(result.bounds.x + result.pill.x).toBe(x)
    expect(result.bounds.y + result.pill.y).toBe(y)
    expect(result.bounds.x + result.open.x).toBe(openX)
    expect(result.bounds.y + result.open.y).toBe(openY)
    expect(result.bounds.x).toBeGreaterThanOrEqual(area.x)
    expect(result.bounds.y).toBeGreaterThanOrEqual(area.y)
    expect(result.bounds.x + result.bounds.width).toBeLessThanOrEqual(0)
    expect(result.bounds.y + result.bounds.height).toBeLessThanOrEqual(800)
  })
  it('fits a small work area while preserving the pill location', () => {
    const result = widgetLayout({ x: 80, y: 130, width: 118, height: 42 }, { x: 0, y: 0, width: 250, height: 200 })
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 250, height: 200 })
    expect(result.pill).toMatchObject({ x: 80, y: 130 })
  })
  it('excludes transparent corners and includes the full animated surface', () => {
    const surface = { x: 200, y: 10, width: 118, height: 42, radius: 10 }
    expect(widgetContains(surface, 200, 10)).toBe(false)
    expect(widgetContains(surface, 205, 15)).toBe(true)
    expect(widgetContains(surface, 190, 30)).toBe(false)
    expect(widgetContains({ ...surface, x: 0, width: 340, height: 390, radius: 16 }, 190, 300)).toBe(true)
  })
})

it('offers Settings only for missing microphone or call audio', () => {
  const model = new WidgetModel()
  model.start({ id: 'meeting', title: 'Review', startedAt: 0 })
  expect(widgetSettings(model.view(0)!.note)).toBeNull()
  model.warn('falling-behind')
  expect(widgetSettings(model.view(0)!.note)).toBeNull()
  model.warn('no-system-audio')
  expect(widgetSettings(model.view(0)!.note)).toBe('systemAudio')
  model.warn('no-mic')
  expect(widgetSettings(model.view(0)!.note)).toBe('mic')
  model.hiccup(0)
  expect(widgetSettings(model.view(1)!.note)).toBeNull()
  expect(widgetSettings(model.view(4001)!.note)).toBe('mic')
})
