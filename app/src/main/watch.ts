import { matchesEvent } from './calendar'
import type { Meeting } from './store'
import { callAppName, callGone, decide, ended, type Prompt, type Signals } from './detect'
import type { Reading } from './detectSignals'

/** Everything the watcher needs from outside, so tests and fake mode can stand in */
export type WatchDeps = {
  read(now: number): Promise<Reading>
  now(): number
  active(): Meeting | null
  bindApp(id: string, app: string): Meeting | undefined
  /** offer to take notes */
  offer(p: Prompt): void
  /** ask whether to stop */
  askStop(m: Meeting): void
  /** take down whichever card is up */
  hide(): void
  /** ms both tracks have been quiet; capture plugs in later (0 until then) */
  silentMs?(): number
  /** stop the recording because its call ended (no question asked) */
  autoStop?(m: Meeting): void
  /** the "Finish recording when the call ends" setting; off or missing: ask instead */
  autoStopOn?(): boolean
  /** how long the call must be gone (CALL_GONE_MS unless fake mode says) */
  graceMs?: number
}

const SNOOZE = 5 * 60_000

/** Looks at the signals each tick: offers notes when a call starts; when it ends, stops the recording (or asks, with that setting off). Never starts anything itself. */
export class Watcher {
  readonly dismissed = new Set<string>()
  private shown: string | null = null // key of the start card, or 'stop'
  private busy = false
  private rec: { id: string; lastMic: number; snoozeUntil: number; /** the call app was on the mic during this recording */ seen: boolean; stopped: boolean } | null = null

  /** call apps on the mic at the last look before recording: a recording started from the card belongs to that call */
  private idleMic = new Set<string>()
  private idleCall: { app: string; at: number } | null = null

  constructor(private d: WatchDeps) {}

  /** the person closed the start card */
  dismiss(key: string) { this.dismissed.add(key); this.shown = null }
  /** "Keep going": ask again in a while, not every tick */
  keepGoing() { if (this.rec) this.rec.snoozeUntil = this.d.now() + SNOOZE; this.shown = null }
  /** the card went away by an action, or a recording started or stopped (a resumed note is watched afresh) */
  cleared() { this.shown = null; this.rec = null }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.d.now()
      const reading = await this.d.read(now)
      const rec = this.d.active()
      const s: Signals = { ...reading, recording: !!rec }
      if (rec) this.recording(rec, s, now)
      else this.idle(s, now)
    } finally { this.busy = false }
  }

  private idle(s: Signals, now: number) {
    this.rec = null
    this.idleMic = new Set(s.micApps.flatMap((m) => callAppName(m.bundleId, s.runningApps) ?? []))
    const call = decide(s, now, new Set())
    this.idleCall = call?.app ? { app: call.app, at: now } : null
    // a call app that let go of the mic is a new call next time
    for (const k of [...this.dismissed]) {
      if (k.startsWith('app:') && !s.micApps.some((m) => callAppName(k.slice(4)) === callAppName(m.bundleId, s.runningApps))) this.dismissed.delete(k)
    }
    const p = decide(s, now, this.dismissed)
    if (!p) { if (this.shown) { this.shown = null; this.d.hide() } return }
    if (this.shown === p.key) return
    this.shown = p.key
    console.info(`CALL offer app=${p.app} mic=${s.micApps.filter(m => callAppName(m.bundleId, s.runningApps) === p.app).map(m => m.bundleId).join(',')}`)
    this.d.offer(p)
  }

  private recording(m: Meeting, s: Signals, now: number) {
    const starting = this.rec?.id !== m.id
    const recent = starting && this.idleCall && now - this.idleCall.at <= 6000 ? this.idleCall.app : null
    const observed = decide({ ...s, recording: false }, now, new Set())?.app ?? null
    if (!m.app && (observed || recent)) {
      m = this.d.bindApp(m.id, (observed || recent)!) ?? m
      if (m.app) console.info(`CALL bind meeting=${m.id} app=${m.app} via=${observed ? 'mic' : 'recent-mic'}`)
    } else if (starting) console.info(`CALL watch meeting=${m.id} app=${m.app ?? 'none'}`)
    if (starting) {
      this.rec = { id: m.id, lastMic: now, snoozeUntil: 0, seen: !!m.app && this.idleMic.has(m.app), stopped: false }
      this.idleCall = null; this.idleMic.clear()
      if (this.shown !== 'stop') this.shown = null
    }
    const r = this.rec!
    if (r.stopped) return
    const onMic = !!m.app && s.micApps.some((a) => { const n = callAppName(a.bundleId, s.runningApps); return n && n === m.app })
    if (onMic) r.seen = true
    // a meeting with no known app has no mic to watch: only the event and silence can end it
    const using = !m.app || onMic
    if (using) r.lastMic = now
    if (this.d.autoStop && this.d.autoStopOn?.() && callGone({ app: m.app, seen: r.seen, micIdleMs: now - r.lastMic, graceMs: this.d.graceMs })) {
      console.info(`CALL gone meeting=${m.id} app=${m.app} idle_ms=${now - r.lastMic}`)
      r.stopped = true
      if (this.shown === 'stop') { this.shown = null; this.d.hide() }
      this.d.autoStop(m)
      return
    }
    const event = s.events.find((e) => matchesEvent(e, m.eventId)) ?? null
    const over = ended(s, now - r.lastMic, { event, silentMs: this.d.silentMs?.() ?? 0, now })
    if (over && this.shown !== 'stop' && now >= r.snoozeUntil) {
      console.info(`CALL stop-card meeting=${m.id} app=${m.app ?? 'none'} reason=${now - r.lastMic >= 30_000 ? 'mic-idle' : 'event-ended-and-silent'} idle_ms=${now - r.lastMic}`)
      this.shown = 'stop'; this.d.askStop(m)
    }
    else if (!over && this.shown === 'stop') { this.shown = null; this.d.hide() }
  }
}
