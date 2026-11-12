import type { RecordingStart } from '../meeting'
import type { Meeting, Store } from '../store'
import { nameFor, othersIn, type CallSample } from './attribute'
import { readCall, summarize, type AxWindow, type CallKind } from './parse'

/**
 * Names from the call: while a meeting records, the call app it is in (Zoom, Teams, Meet in a browser) is read through
 * macOS Accessibility about twice a second, and each line of the other side is named after the person the app shows
 * talking, or the only other person in the call. The mic is always You. Without the permission, in another app, or
 * when the app shows nothing clear, lines of the other side are Them. Nothing is guessed, and nothing leaves the Mac.
 */

/** what yogurt-mac call-watch prints each time it reads: the call windows, or why it could not */
export type WatchLine = { t: number; app?: string; windows?: AxWindow[]; error?: string }
export type Watch = (ids: string[], onLine: (l: WatchLine) => void) => { stop(): void }

/** the call apps that can be read, by the name meeting detection gives them (detect.ts), and the kind of window each has */
const APPS: Record<string, { kind: CallKind; ids: string[] }> = {
  Zoom: { kind: 'zoom', ids: ['us.zoom.xos'] },
  Teams: { kind: 'teams', ids: ['com.microsoft.teams2', 'com.microsoft.teams'] },
  Chrome: { kind: 'meet', ids: ['com.google.Chrome'] },
  Arc: { kind: 'meet', ids: ['company.thebrowser.Browser'] },
  Brave: { kind: 'meet', ids: ['com.brave.Browser'] },
  Edge: { kind: 'meet', ids: ['com.microsoft.edgemac'] },
  Safari: { kind: 'meet', ids: ['com.apple.Safari'] },
  Firefox: { kind: 'meet', ids: ['org.mozilla.firefox'] },
}
/** The apps to read for a meeting: the one it was detected in; with none (started by hand) any of them, the frontmost with a call first */
export const watchIds = (app: string | null): string[] => (app ? APPS[app]?.ids ?? [] : Object.values(APPS).flatMap((a) => a.ids))
const kindOf = (bundleId: string): CallKind | null => Object.values(APPS).find((a) => a.ids.includes(bundleId))?.kind ?? null

/** how often the app is read */
export const WATCH_EVERY_MS = 400
/** the apps mark the person talking about this late (Zoom: about 0.75 to 1.2 s after they start) */
const APP_LAG_MS = 750
/** changes of who talks written to the log, per meeting (enough to check a real call, never a flood) */
const LOGGED_CHANGES = 30

type Sample = Omit<CallSample, 'ms'> & { t: number }
type Session = { samples: Sample[]; priorLines: Set<number>; watch?: { stop(): void }; offset?: number; startedAt: number; pictured: boolean; errors: Set<string>; last: string; logged: number }

export function hookCallNames(p: {
  store: Pick<Store, 'meeting' | 'segments' | 'setSegmentSpeakers' | 'updateMeeting'>
  watch: Watch
  /** the person's own names (Settings, the Mac's full name): never given to the other side */
  myNames: () => string[]
  /** the meeting's transcript is all saved */
  transcribed: (id: string) => Promise<void>
  /** lines got their names after the meeting: the window reads them again */
  changed: (id: string) => void
  onStart: (fn: (m: RecordingStart) => void) => unknown
  onStop: (fn: (m: Meeting) => void) => unknown
  onCapture: (fn: (c: { on(e: 'pcm', fn: (track: 'me' | 'them', ms: number, samples: Float32Array) => void): unknown }, meetingId: string) => void) => unknown
  log?: (msg: string) => void
  now?: () => number
}) {
  const log = p.log ?? ((s: string) => console.log(s))
  const now = p.now ?? Date.now
  const sessions = new Map<string, Session>()
  const finals = new Map<string, Promise<void>>()

  /** the readings in meeting time: the wall clock less when meeting time 0 was heard, less the app's lag */
  const timeline = (s: Session): CallSample[] => {
    const zero = s.offset ?? s.startedAt
    return s.samples.map(({ t, ...r }) => ({ ...r, ms: t - zero - APP_LAG_MS }))
  }

  const onLine = (id: string, s: Session, l: WatchLine) => {
    if (l.error || !l.app || !l.windows) {
      const why = l.error ?? 'nothing read'
      if (!s.errors.has(why)) { s.errors.add(why); log(`call names: ${why}${why === 'not-trusted' ? ' (no Accessibility permission): the other side stays Them' : ''}`) }
      s.samples.push({ t: l.t, speaking: [], participants: [], me: null, ok: false })
      return
    }
    const kind = kindOf(l.app)
    if (!kind) return
    // the first reading of each meeting goes to the log in short, so a real call shows what its app gives
    if (!s.pictured) { s.pictured = true; log(`call names: reading ${l.app} (${kind}), its window in short:\n${summarize(l.windows)}`) }
    const r = readCall(kind, l.windows)
    s.samples.push({ t: l.t, ...r })
    const said = `${r.speaking.join(', ') || '-'} of ${r.participants.length}${r.me ? ', me known' : ''}`
    if (said !== s.last && s.logged < LOGGED_CHANGES) { s.logged++; log(`call names: ${kind} talking ${said}`) }
    s.last = said
  }

  p.onStart((m) => {
    const ids = watchIds(m.app)
    const s: Session = { samples: [], priorLines: new Set(p.store.segments(m.id, { hidden: true }).map((line) => line.id)), startedAt: m.resume ? m.resume.startedAt - m.resume.startMs : m.startedAt, pictured: false, errors: new Set(), last: '', logged: 0 }
    sessions.set(m.id, s)
    if (!ids.length) { log(`call names: ${m.app} can't be read, the other side is Them`); return }
    try { s.watch = p.watch(ids, (l) => onLine(m.id, s, l)) } catch (e) { console.error('call names: the watch did not start', e) }
  })

  // meeting time 0 on the wall clock: the earliest any audio could have been heard (each frame arrives a little after it was said)
  p.onCapture((c, id) => {
    c.on('pcm', (_track, ms, samples) => {
      const s = sessions.get(id)
      if (!s) return
      const zero = now() - (ms + samples.length / 16)
      s.offset = Math.min(s.offset ?? Infinity, zero)
    })
  })

  p.onStop((m) => {
    const s = sessions.get(m.id)
    if (!s) return
    s.watch?.stop(); s.watch = undefined
    const final = (async () => {
      await p.transcribed(m.id)
      const tl = timeline(s)
      const o = { myNames: p.myNames() }
      // every line of the other side again, now that the whole call is known
      const lines = p.store.segments(m.id, { hidden: true }).filter((x) => x.track === 'them' && !s.priorLines.has(x.id))
      const names = lines.map((x) => ({ id: x.id, speaker: nameFor(x, tl, o) }))
      const moved = names.filter((x, i) => x.speaker !== lines[i].speaker)
      if (moved.length) p.store.setSegmentSpeakers(moved)
      // everyone seen in the call is one of the people at the meeting
      const cur = p.store.meeting(m.id)
      const known = new Set(cur?.attendees.map((a) => a.name.toLocaleLowerCase()) ?? [])
      const added = othersIn(tl, o).filter((n) => !known.has(n.toLocaleLowerCase()))
      if (cur && added.length) p.store.updateMeeting(m.id, { attendees: [...cur.attendees, ...added.map((name) => ({ name, email: null }))] })
      log(`call names: ${s.samples.length} readings, ${names.filter((x) => x.speaker).length} of ${lines.length} lines of the other side named, ${added.length} people added`)
      if (moved.length || added.length) p.changed(m.id)
    })().catch((e) => console.error('call names after the meeting failed', e)).finally(() => { sessions.delete(m.id); finals.delete(m.id) })
    finals.set(m.id, final)
  })

  return {
    /** the name for a line of the other side just heard, or null for Them */
    nameFor(meetingId: string, startMs: number, endMs: number): string | null {
      const s = sessions.get(meetingId)
      return s?.samples.length ? nameFor({ startMs, endMs }, timeline(s), { myNames: p.myNames() }) : null
    },
    /** resolves when the names after the meeting are in */
    finished: (id: string): Promise<void> => finals.get(id) ?? Promise.resolve(),
  }
}
export type CallNames = ReturnType<typeof hookCallNames>
