/** Keep the recording's local time when browsing dates, including daylight-saving changes. */
export function shiftCalendarDay(at: number, days: number): number {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}
export function nearestEvents<T extends { start: number }>(events: T[], at: number): T[] {
  return [...events].sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at) || a.start - b.start)
}
