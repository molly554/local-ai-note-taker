import type { CalEvent } from '../main/calendar'

const MIN = 60_000

/**
 * The event whose Start notes gets the filled button: the soonest one starting within 15 minutes, else the one on
 * now that started last (an all-day block running since morning never wins over the meeting about to begin).
 */
export function pickNext(events: CalEvent[], now: number): string | undefined {
  const soon = events.filter((e) => e.start > now && e.start - now < 15 * MIN).sort((a, b) => a.start - b.start)
  if (soon.length) return soon[0].id
  const on = events.filter((e) => e.start <= now && e.end > now).sort((a, b) => b.start - a.start)
  return on[0]?.id
}
