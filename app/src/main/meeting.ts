import { eventIds, type CalEvent } from './calendar'
import type { Meeting, Store } from './store'
import type { MeetingView } from '../shared/types'
import { t } from '../shared/i18n'
import { sourceOf } from './titles'

/**
 * A meeting's life: optionally prepare a note, start recording, then stop (state stopped, end time).
 * Capture, transcription and the notes queue plug in through the hooks below, so none of them is known here.
 * Nothing starts by itself: only the person's click calls startMeeting.
 */
let store: Store | undefined
let active: Meeting | null = null
/** A stopped capture whose state/end time could not be saved. Kept for explicit retry while the app is open. */
const pendingStops = new Map<string, Meeting>()

export type RecordingStart = Meeting & { resume?: { part: number; startMs: number; startedAt: number; capturedMs: number } }
type Hook = (m: RecordingStart) => void
let clock: { startedAt: number; before: number; pausedAt: number | null; pausedMs: number; measured: boolean } | null = null
const starts: Hook[] = [], stops: Hook[] = [], savedStops: Hook[] = [], changes: Hook[] = []
const on = (list: Hook[]) => (fn: Hook) => { list.push(fn); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) } }
/** called after a meeting starts (capture hooks in here) */
export const onMeetingStart = on(starts)
/** called once when capture must stop, even if saving its final state fails */
export const onMeetingStop = on(stops)
/** called once after the stopped state is saved; generation must wait for this */
export const onMeetingStopSaved = on(savedStops)
/** called after any change to a meeting, for the windows to refresh */
export const onMeetingChange = on(changes)

// A hook that throws must never take the recording down with it
function run(list: Hook[], m: RecordingStart) {
  for (const fn of [...list]) { try { fn(m) } catch (e) { console.error('meeting hook failed', e) } }
}

export function initMeetings(s: Store) { store = s; active = null; clock = null; pendingStops.clear() }
export const activeMeeting = (): Meeting | null => active
export const stopSavePending = (id: string): boolean => pendingStops.has(id)
/** Keep edits made after Stop, but never require a readable database to describe stopped capture. */
function latestStopped(pending: Meeting): Meeting {
  let current = pending
  try { current = store?.meeting(pending.id) ?? pending } catch { /* the in-memory stop is still known */ }
  return { ...current, state: 'stopped', endedAt: pending.endedAt, ...(pending.durationMs == null ? {} : { durationMs: pending.durationMs }) }
}
export const getMeeting = (id: string): MeetingView | undefined => {
  const pending = pendingStops.get(id)
  return pending ? { ...latestStopped(pending), stopSavePending: true } : store?.meeting(id)
}
/** A failed metadata save must not make Home claim a stopped capture is still recording. */
export const withStopState = <T extends Meeting>(m: T): T => {
  const pending = pendingStops.get(m.id)
  return pending ? { ...m, state: 'stopped', endedAt: pending.endedAt, ...(pending.durationMs == null ? {} : { durationMs: pending.durationMs }) } : m
}

export function startMeeting(p: { title: string; event: CalEvent | null; app: string | null }): Meeting {
  if (!store) throw new Error('Meetings are not ready yet')
  if (active) return active
  const prepared = p.event && eventIds(p.event).map((id) => store!.meetingForEvent(id)).find(Boolean)
  if (prepared?.state === 'prepared') return startPreparedMeeting(prepared.id, p.app)!
  const title = p.title || t('Meeting')
  const m = store.createMeeting({
    title, titleSource: sourceOf(title, p.event?.id ?? null), startedAt: Date.now(), endedAt: null, eventId: p.event?.id ?? null,
    app: p.app, attendees: p.event?.attendees ?? [], state: 'recording',
  })
  active = m
  clock = { startedAt: Date.now(), before: 0, pausedAt: null, pausedMs: 0, measured: false }
  run(starts, m); run(changes, m)
  return m
}

/** Bind only the current, unbound recording; persist it for recovery and diagnostics. */
export function bindMeetingApp(id: string, app: string): Meeting | undefined {
  if (!active || active.id !== id || active.app) return undefined
  return update(id, { app })
}

/** Prepare an agenda without opening the microphone or joining the post-recording recovery queue. */
export function prepareMeeting(event: CalEvent): Meeting {
  if (!store) throw new Error('Meetings are not ready yet')
  const existing = eventIds(event).map((id) => store!.meetingForEvent(id)).find(Boolean)
  if (existing) return existing
  const m = store.createMeeting({
    title: event.title || t('Meeting'), titleSource: 'calendar', startedAt: event.start, endedAt: null,
    eventId: event.id, app: null, attendees: event.attendees, state: 'prepared',
  })
  store.markPrepared(m.id, event.end)
  run(changes, m)
  return m
}

/** Start capture once, in the prepared note itself. Finished recordings must never be overwritten. */
export function startPreparedMeeting(id: string, app: string | null = null): Meeting | undefined {
  if (!store) return undefined
  if (active) return active
  const prepared = store.meeting(id)
  // a note in the Trash records nothing until it is restored
  if (prepared?.state !== 'prepared' || prepared.trashedAt != null) return undefined
  const m: Meeting = { ...prepared, state: 'recording', startedAt: Date.now(), endedAt: null, app }
  store.updateMeeting(id, { state: m.state, startedAt: m.startedAt, endedAt: null, app })
  active = m
  clock = { startedAt: Date.now(), before: 0, pausedAt: null, pausedMs: 0, measured: false }
  run(starts, m); run(changes, m)
  return m
}

/** Append only after the caller has settled old writers and inspected the retained audio. */
export function resumeMeeting(id: string, append: { part: number; startMs: number }): Meeting | undefined {
  if (!store || active || pendingStops.has(id) || !Number.isSafeInteger(append.part) || append.part < 1 || !Number.isFinite(append.startMs) || append.startMs < 0) return undefined
  const previous = store.meeting(id)
  if (!previous || (previous.state !== 'stopped' && previous.state !== 'done')) return undefined
  const now = Date.now(), capturedMs = previous.durationMs ?? append.startMs
  const m: Meeting = { ...previous, state: 'recording', endedAt: null }
  store.updateMeeting(id, { state: 'recording', endedAt: null })
  active = m
  clock = { startedAt: now, before: capturedMs, pausedAt: null, pausedMs: 0, measured: true }
  run(starts, { ...m, resume: { ...append, startedAt: now, capturedMs } }); run(changes, m)
  return m
}

/** Called only after the active helper accepted the pause/resume command. */
export function pauseMeetingClock(id: string, paused: boolean) {
  if (active?.id !== id || !clock) return
  const now = Date.now()
  if (paused && clock.pausedAt === null) { clock.pausedAt = now; clock.measured = true }
  else if (!paused && clock.pausedAt !== null) { clock.pausedMs += Math.max(0, now - clock.pausedAt); clock.pausedAt = null }
}

export function stopMeeting(id: string): MeetingView | undefined {
  if (!store) return undefined
  const pending = pendingStops.get(id)
  if (pending) return { ...pending, stopSavePending: true }
  // Stopping live capture must never depend on a successful database read.
  const cur = active?.id === id ? active : store.meeting(id)
  if (!cur || cur.state !== 'recording') return cur
  const endedAt = Date.now()
  const durationMs = active?.id === id && clock?.measured ? Math.max(0, clock.before + (clock.pausedAt ?? endedAt) - clock.startedAt - clock.pausedMs) : undefined
  const m: Meeting = { ...cur, state: 'stopped', endedAt, ...(durationMs == null ? {} : { durationMs }) }
  pendingStops.set(id, m)
  if (active?.id === id) { active = null; clock = null }
  run(stops, m)
  const saved = retryStopSave(id)
  return saved ? m : { ...m, stopSavePending: true }
}

/** Retry only metadata, retaining the original stop time; capture/finalization hooks never run twice. */
export function retryStopSave(id: string): boolean {
  const pending = pendingStops.get(id)
  if (!pending) return true
  const m = latestStopped(pending)
  pendingStops.set(id, m)
  try {
    store!.updateMeeting(id, { state: 'stopped', endedAt: m.endedAt, ...(m.durationMs == null ? {} : { durationMs: m.durationMs }) })
    pendingStops.delete(id)
  } catch (e) {
    console.error('recording stopped but its end time was not saved', id, e)
    run(changes, m)
    return false
  }
  run(savedStops, m)
  run(changes, m)
  return true
}

/** The longest title kept; a pasted paragraph is cut */
export const TITLE_MAX = 200
/** The person's own title: spaces tidied, at most TITLE_MAX characters; blank leaves it as it was */
export function renameMeeting(id: string, raw: string): Meeting | undefined {
  if (!store) return undefined
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  if (!title || !store.meeting(id)) return undefined
  store.updateMeeting(id, { title, titleSource: 'user' })
  const m = store.meeting(id)!
  if (active?.id === id) active = m
  run(changes, m)
  return m
}

/** At most this many people on one meeting; a pasted list is cut */
export const PEOPLE_MAX = 100
const tidy = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Who was there, as the person set it: names tidied, rows without a name dropped */
export function setAttendees(id: string, people: unknown): Meeting | undefined {
  if (!store || !store.meeting(id) || !Array.isArray(people)) return undefined
  const attendees = people.slice(0, PEOPLE_MAX).flatMap((p: { name?: unknown; email?: unknown }) => {
    const name = tidy(p?.name, TITLE_MAX)
    return name ? [{ name, email: tidy(p?.email, TITLE_MAX) || null }] : []
  })
  return update(id, { attendees })
}

/** The note belongs to this calendar event: its title and people */
export function linkEvent(id: string, event: CalEvent): Meeting | undefined {
  const meeting = store?.meeting(id)
  if (!store || !meeting) return undefined
  if (meeting.state === 'prepared') store.markPrepared(id, event.end)
  return update(id, { eventId: event.id, eventStartedAt: event.start, title: event.title || meeting.title, ...(event.title ? { titleSource: 'calendar' as const } : {}), attendees: event.attendees })
}

/** Remove only the calendar association; the title, people and notes belong to the person now. */
export function unlinkEvent(id: string): Meeting | undefined {
  if (!store || !store.meeting(id)) return undefined
  return update(id, { eventId: null, eventStartedAt: null })
}

function update(id: string, patch: Partial<Omit<Meeting, 'id'>>): Meeting {
  store!.updateMeeting(id, patch)
  const m = store!.meeting(id)!
  if (active?.id === id) active = m
  run(changes, m)
  return m
}
