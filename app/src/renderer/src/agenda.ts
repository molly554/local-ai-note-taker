/** Local noon avoids shifting the selected date at daylight-saving boundaries. */
export function shiftDay(at: number, offset: number): number {
  const date = new Date(at)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return date.getTime()
}
export function weekDates(at: number): number[] {
  return Array.from({ length: 7 }, (_, i) => shiftDay(at, i - new Date(at).getDay()))
}
export const eventPhase = (event: { start: number; end: number }, now: number) =>
  now < event.start ? 'upcoming' : now < event.end ? 'live' : 'past'
