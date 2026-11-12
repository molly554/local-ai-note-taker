import { describe, expect, it } from 'vitest'
import { isAppRoute } from '../src/shared/routes'
import { shiftDay, weekDates, eventPhase } from '../src/renderer/src/agenda'

describe('workspace routes', () => {
  it('accepts only local destinations and meeting IDs', () => {
    for (const route of ['', '/meetings', '/chat', '/trash', '/settings', '/note/a-123', '/chat/c-123', '/folder/b-456']) expect(isAppRoute(route)).toBe(true)
    for (const route of [null, 1, '/note/', '/note/../secrets', '/note/a?x=1', '/folder/', '/folder/../x', '/folders', 'https://example.com', '/other']) expect(isAppRoute(route)).toBe(false)
  })
})
describe('agenda dates', () => {
  it('keeps local dates and noon across the daylight-saving boundary', () => {
    const start = new Date(2026, 9, 31, 12).getTime()
    const next = new Date(shiftDay(start, 1))
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([10, 1, 12])
    expect(new Date(shiftDay(start, 2)).getDate()).toBe(2)
    const week = weekDates(next.getTime()).map((at) => new Date(at))
    expect(week.map((d) => d.getDay())).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(week.every((d) => d.getHours() === 12)).toBe(true)
    expect(new Date(shiftDay(new Date(2026, 11, 31, 12).getTime(), 1)).getFullYear()).toBe(2027)
  })
  it('uses the actual start and end to label meetings, including exact boundaries', () => {
    const event = { start: 100, end: 200 }
    expect(eventPhase(event, 99)).toBe('upcoming')
    expect(eventPhase(event, 100)).toBe('live')
    expect(eventPhase(event, 199)).toBe('live')
    expect(eventPhase(event, 200)).toBe('past')
  })
})
