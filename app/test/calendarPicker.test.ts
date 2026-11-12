import { expect, it } from 'vitest'
import { nearestEvents, shiftCalendarDay } from '../src/shared/calendarPicker'

it('orders events nearest the recording first without mutating calendar order, including ties', () => {
  const events = [{ id: 'late', start: 140 }, { id: 'early', start: 80 }, { id: 'near', start: 101 }, { id: 'tie', start: 120 }]
  expect(nearestEvents(events, 100).map(e => e.id)).toEqual(['near', 'early', 'tie', 'late'])
  expect(events[0].id).toBe('late')
})
it('moves by local calendar days across month and daylight-saving boundaries', () => {
  const at = new Date(2026, 10, 1, 12).getTime()
  const previous = new Date(shiftCalendarDay(at, -1)), next = new Date(shiftCalendarDay(at, 1))
  expect([previous.getMonth(), previous.getDate(), previous.getHours()]).toEqual([9, 31, 12])
  expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([10, 2, 12])
})
