import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { userDataDir } from './paths'
import { basename, dirname, join } from 'node:path'
import type { Hardware } from '@yogurt/picker'
import type { DownloadDeps } from './downloader'
import type { Helper } from './calendar'
import type { Reading } from './detectSignals'
import type { Store } from './store'

let releaseAudioMetadata: (() => void) | undefined, audioMetadataGate: Promise<void> | undefined
let audioMetadataReleased = false
/** Deterministic CI ordering for a transcript click before the player's metadata is available. */
export function waitForFakeAudioMetadata(): Promise<void> | undefined {
  if (process.env.YOGURT_FAKE_AUDIO_METADATA_GATE !== '1' || audioMetadataReleased) return
  return audioMetadataGate ??= new Promise<void>(resolve => { releaseAudioMetadata = resolve })
}

/** Fake mode: the same Mac every time, so tests don't depend on the one they run on */
/** a fake Mac; with YOGURT_FAKE_PLATFORM the same machine says it runs Windows or Linux (so their speed check runs) */
export const fakeHardware = async (platform = 'darwin'): Promise<Hardware> => ({
  os: platform as Hardware['os'], arch: 'arm64', cpuModel: 'Apple M2 Max', totalRamGB: 34.4, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M2 Max', vramGB: 0 },
})

/** Fake mode: files appear after four quick progress steps (a notes model takes notesMs longer); the hash always matches */
export const fakeDownloadDeps = (opts: { freeDiskGB?: number; stepMs?: number; notesMs?: number } = {}): DownloadDeps => ({
  async download(_url, dir, fileName, onProgress, signal) {
    const step = (opts.stepMs ?? 20) + (basename(dir) === 'llm' ? (opts.notesMs ?? 0) / 4 : 0)
    for (const f of [0.25, 0.5, 0.75, 1]) {
      if (signal?.aborted) throw Object.assign(new Error('Download stopped'), { name: 'AbortError' })
      onProgress({ fraction: f, etaSec: 0 }); await new Promise((r) => setTimeout(r, step))
    }
    mkdirSync(dirname(join(dir, fileName)), { recursive: true })
    writeFileSync(join(dir, fileName), 'fake')
  },
  async hashFile() { return 'FAKE' },
  async freeDiskGB() { return opts.freeDiskGB ?? 1000 },
})

// ---- calendar and meeting detection (fake mode only) ----

/** Fake mode: Calendar access as YOGURT_FAKE_CALENDAR says (granted unless told notDetermined or denied); asking grants it unless denied */
let calendar = process.env.YOGURT_FAKE_CALENDAR ?? 'granted'
/** tests: the calendar's events as given, instead of the usual two (null: the usual) */
let eventsOverride: unknown[] | null = null
export const setFakeCalendar = (o: { status?: string; events?: unknown[] | null }) => {
  if (o.status) calendar = o.status
  if (o.events !== undefined) eventsOverride = o.events
}
/**
 * Fake mode: microphone, call audio and notifications as YOGURT_FAKE_PERMISSIONS says (granted unless told unknown or denied).
 * Asking turns unknown into granted; denied stays denied. Calendar follows YOGURT_FAKE_CALENDAR.
 */
const startAs = (process.env.YOGURT_FAKE_PERMISSIONS ?? 'granted') as FakeAccess
type FakeAccess = 'granted' | 'denied' | 'unknown' | 'restricted'
/** YOGURT_FAKE_MIC, YOGURT_FAKE_NOTIFICATIONS and YOGURT_FAKE_AX override one of them (restricted: a managed Mac) */
export const fakeAccess: Record<'mic' | 'systemAudio' | 'notifications' | 'accessibility', FakeAccess> = {
  mic: (process.env.YOGURT_FAKE_MIC as FakeAccess) ?? startAs, systemAudio: startAs, notifications: (process.env.YOGURT_FAKE_NOTIFICATIONS as FakeAccess) ?? startAs,
  // YOGURT_FAKE_AX: Accessibility on its own (names from the fake Zoom call need it)
  accessibility: (process.env.YOGURT_FAKE_AX as FakeAccess) ?? startAs,
}
/** YOGURT_FAKE_PLAYER=1: Music is running, and the Mac hasn't asked about controlling it yet */
let playerAsked = process.env.YOGURT_FAKE_PLAYER !== '1'
/** YOGURT_FAKE_ANSWER=deny: the person says no to the Mac's prompts */
const answer: FakeAccess = process.env.YOGURT_FAKE_ANSWER === 'deny' ? 'denied' : 'granted'
const ask = (k: keyof typeof fakeAccess) => { if (fakeAccess[k] === 'unknown') fakeAccess[k] = answer }
export const askFakeNotifications = () => { ask('notifications'); return fakeAccess.notifications }
/** fake mode: every media-pause, media-resume and media-auth the helper was asked for; YOGURT_FAKE_MUSIC=1 has Music playing */
export const mediaCalls: string[][] = []
/** also on disk, so a test can see what happened while Yogurt quit */
const logMedia = (args: string[]) => { mediaCalls.push(args); try { appendFileSync(join(userDataDir(), 'fake-media.log'), args.join(' ') + '\n') } catch { /* tests only */ } }
let musicPlaying = process.env.YOGURT_FAKE_MUSIC === '1'
const standupAt = Date.now() + 5 * 60_000

/** Fake mode: the Mac's microphones, as yogurt-mac mic-devices lists them; the built-in one is the Mac's input */
export type FakeMic = { uid: string; name: string; default: boolean }
const FAKE_MICS: FakeMic[] = [
  { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', default: true },
  { uid: 'fake-yeti', name: 'Yeti Stereo Microphone', default: false },
  { uid: 'fake-iphone', name: 'iPhone Microphone', default: false },
]
let fakeMics = FAKE_MICS
export const fakeMicList = (): FakeMic[] => fakeMics.map((m) => ({ ...m }))
/** tests: plug mics in or out (null: the usual three); the fake recorder notices like the real one */
export const setFakeMics = (list: FakeMic[] | null) => { fakeMics = list ? list.map((m) => ({ ...m })) : FAKE_MICS }

/** Fake mode: the Mac helper's answers. Events are a standup starting in five minutes and a review tomorrow morning; nobody is on the mic until a test says so. */
export const fakeHelper: Helper = async (args) => {
  // error: the helper itself fails, for every calendar question
  if (calendar === 'error' && (args[0].startsWith('calendar') || args[0] === 'events')) throw new Error('The Mac helper failed')
  switch (args[0]) {
    case 'calendar-status': return { status: calendar }
    case 'calendar-auth': if (calendar === 'notDetermined') calendar = answer; return { status: calendar }
    case 'calendars': {
      const list = eventsOverride?.flatMap((e) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).calendarId === 'string' ? [e as Record<string, unknown>] : [])
      return list ? [...new Map(list.map((e) => [e.calendarId, { id: e.calendarId, name: e.calendar, source: e.calendarSource ?? 'Example account', color: e.calendarColor ?? '#3478F6' }])).values()] : [{ id: 'work', name: 'Work', source: 'Example account' }]
    }
    case 'events': {
      // like the Mac's calendar: only what overlaps FROM to TO, so a wrong range or day shows in tests
      const within = (e: unknown) => !!e && typeof e === 'object' && Date.parse(String((e as { end?: unknown }).end)) > Date.parse(args[1]) && Date.parse(String((e as { start?: unknown }).start)) < Date.parse(args[2])
      if (eventsOverride) return eventsOverride.filter(within)
      // fixed from launch, so the same event keeps the same id while a test runs
      const start = standupAt
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0)
      return [{
        id: `fake-standup:${new Date(start).toISOString()}`, title: 'Team standup', start: new Date(start).toISOString(), end: new Date(start + 30 * 60_000).toISOString(), calendar: 'Work', calendarId: 'work', calendarSource: 'Example account',
        url: 'https://meet.google.com/fak-eeve-ntx', attendees: [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo Park', email: null }],
      }, {
        id: `fake-review:${tomorrow.toISOString()}`, title: 'Design review', start: tomorrow.toISOString(), end: new Date(tomorrow.getTime() + 45 * 60_000).toISOString(), calendar: 'Work', calendarId: 'work', calendarSource: 'Example account',
        url: null, attendees: [{ name: 'Maya Chen', email: 'maya@example.com' }, { name: 'Alex Kim', email: null }, { name: 'Sam Ito', email: null }],
      }].filter(within)
    }
    case 'mic-apps': return []
    case 'mic-devices': return { devices: fakeMicList() }
    case 'permissions': return {
      mic: { granted: 'authorized', denied: 'denied', unknown: 'notDetermined', restricted: 'restricted' }[fakeAccess.mic],
      systemAudio: { granted: 0, denied: 1, unknown: 2, restricted: 1 }[fakeAccess.systemAudio], calendar, accessibility: fakeAccess.accessibility === 'granted',
      players: playerAsked ? [] : [{ id: 'com.apple.Music', status: 'unknown' }],
    }
    case 'media-auth': mediaCalls.push(args); playerAsked = true; return { players: [] }
    case 'mic-auth': ask('mic'); return {}
    case 'audio-auth': ask('systemAudio'); return {}
    // like the Mac: asking only puts Yogurt in the list unless YOGURT_FAKE_AX_PROMPT=grant; it is turned on in System Settings
    case 'ax-auth': if (process.env.YOGURT_FAKE_AX_PROMPT === 'grant') ask('accessibility'); return { trusted: fakeAccess.accessibility === 'granted' }
    case 'media-pause': { logMedia(args); const paused = musicPlaying ? ['com.apple.Music'] : []; musicPlaying = false; return { paused } }
    case 'media-resume': logMedia(args); if (args.includes('com.apple.Music')) musicPlaying = true; return { resumed: args.slice(1) }
    default: return {}
  }
}

/** Fake mode: every prompt whisper and the notes model were given, for tests to read (prompts()) */
export const fakePrompts = { whisper: [] as string[], notes: [] as string[], /** what was read in ahead of a prompt */ preloads: [] as string[], /** the language whisper was told for each chunk ('auto': detect) */ languages: [] as string[] }

/** Fake mode: a clock tests can move forward, so "30 seconds without the mic" does not take 30 seconds. YOGURT_FAKE_CALL_GONE_MS shortens the wait before a recording stops by itself when its call ends */
let skew = 0
export const fakeNow = () => Date.now() + skew

/**
 * The hook the end-to-end tests drive, reachable from the test as globalThis.__fake__. Installed only under YOGURT_FAKE=1.
 *   signals({ micApps, events })  pretend the Mac said this, then look at it right away
 *   advance(ms)                   move the clock forward
 *   widget()                      what the recording widget shows and where it sits
 *   go(route)                     show a page, as the card or widget would (e.g. /note/<id>)
 *   main()                        whether the main window was brought forward, is visible, and its route
 *   warn(code)                    the audio helper warns (no-mic, no-system-audio)
 *   crashCapture()                kill the audio helper as if it crashed
 *   manyMeetings(n)               n finished meetings over the past months, with notes (home and search)
 *   calendarEvents(list | null)   the calendar has these events (null: the usual two)
 *   calendarStatus(s)             Calendar access is now s (granted, denied, notDetermined, error)
 *   tray() / trayClick(id)        the menu bar menu's labels; click one (open, new, stop, quit)
 *   trayAccelerators()            the menu's shortcuts by label (Ctrl off a Mac)
 *   permissions()                 what permissions.status() says now
 *   accessibility(on)             the person changes Accessibility access in System Settings
 *   permission([kind, access])    the person changes any of them in System Settings (mic, systemAudio, notifications, accessibility, calendar)
 *   notice() / noticeClick()      the system notification shown with the card (null: none); a click on it
 *   micDevices(list | null)       the Mac's mics are now these ({uid, name, default}; null: the usual three)
 *   chatMeetings()                two finished meetings with transcripts and notes, indexed for chat across meetings (their ids)
 *   prompts()                     what whisper and the notes model were given so far
 */
export function installFakeHooks(h: { signals(r: Reading): Promise<void>; advance(ms: number): Promise<void>; widget(): unknown; main(): unknown; go(route: string): void; crashCapture(): void; warn(code: string): void; bigMeeting(n: number): string; manyMeetings(o: number | { n: number; clean?: boolean }): void; calendarChanged(): void; tray(): string[]; trayClick(id: string): void; trayAccelerators(): Record<string, string | undefined>; permissions(): Promise<unknown>; notice(): unknown; noticeClick(): void; chatMeetings(): Promise<string[]> }) {
  ;(globalThis as Record<string, unknown>).__fake__ = {
    audioMetadataRelease: () => { audioMetadataReleased = true; releaseAudioMetadata?.() },
    signals: h.signals,
    advance: async (ms: number) => { skew += ms; await h.advance(ms) },
    widget: h.widget,
    main: h.main,
    go: h.go,
    crashCapture: h.crashCapture,
    warn: h.warn,
    bigMeeting: h.bigMeeting,
    manyMeetings: h.manyMeetings,
    tray: h.tray,
    trayClick: h.trayClick,
    trayAccelerators: h.trayAccelerators,
    permissions: h.permissions,
    accessibility: (on: boolean) => { fakeAccess.accessibility = on ? 'granted' : 'denied' },
    permission: ([kind, access]: [string, FakeAccess]) => {
      if (kind === 'calendar') calendar = { granted: 'granted', denied: 'denied', unknown: 'notDetermined', restricted: 'restricted' }[access]
      else if (kind in fakeAccess) fakeAccess[kind as keyof typeof fakeAccess] = access
    },
    notice: h.notice,
    noticeClick: h.noticeClick,
    chatMeetings: h.chatMeetings,
    calendarEvents: (events: unknown[] | null) => { setFakeCalendar({ events }); h.calendarChanged() },
    calendarStatus: (status: string) => setFakeCalendar({ status }),
    micDevices: (list: FakeMic[] | null) => setFakeMics(list),
    prompts: () => fakePrompts,
  }
}

const TITLES = ['Budget review', 'Weekly sync', 'Customer call with Acme', 'Design crit', '1:1 with Maya', 'Hiring loop', 'Roadmap planning', 'Pricing workshop']
const PEOPLE = [{ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Bo Park', email: null }, { name: 'Maya Chen', email: 'maya@example.com' }, { name: 'Alex Kim', email: null }]
const NOTES: Record<string, string> = {
  'Budget review': '## Budget\n- The Q3 budget stays as planned.\n- Travel spend is **down** a little.\n## Next steps\n- **You:** Send the budget sheet to finance.',
  'Weekly sync': '## Updates\n- The site goes live on Tuesday.\n- Support load is steady.',
  'Customer call with Acme': '## What they need\n- Faster exports and a simpler invite flow.\n- They asked about the price for 50 seats.',
  'Design crit': '## Feedback\n- The home screen feels calm; the search needs more contrast.',
  '1:1 with Maya': '## Topics\n- Maya wants to lead the onboarding work.\n- Check in again in two weeks.',
  'Hiring loop': '## Candidate\n- Strong on systems, lighter on product sense.',
  'Roadmap planning': '## Q4\n- Calendar sync first, then sharing.\n- Keep the budget for the contractor.',
  'Pricing workshop': '## Pricing\n- Test a lower first tier.\n- Keep yearly plans.',
}

/** Fake mode: n finished meetings, about every five hours back from now, with notes; the newest has Chinese lines and markup in its notes */
export function manyMeetings(store: Store, n: number, clean = false) {
  let first: string | undefined
  store.db.exec('BEGIN')
  try {
    for (let i = 0; i < n; i++) {
      const title = TITLES[i % TITLES.length]
      const startedAt = Date.now() - (i * 5 + 2) * 3_600_000
      const m = store.createMeeting({ title, startedAt, endedAt: startedAt + (25 + (i % 4) * 10) * 60_000, eventId: null, app: null, attendees: PEOPLE.slice(0, i % 5), state: 'done' })
      store.setNotes(m.id, { mine: i === 1 && !clean ? 'Raw <img src=x onerror="window.pwned=true"> in a script note' : '', enhanced: i === 1 && !clean ? null : NOTES[title] })
      if (i === 0) first = m.id
    }
    store.db.exec('COMMIT')
  } catch (e) { store.db.exec('ROLLBACK'); throw e }
  if (first) store.addSegments([{ meetingId: first, track: 'them', startMs: 0, endMs: 2000, text: '我们下周讨论预算的问题', speaker: null }])
}

/** Fake mode: two finished meetings to ask about across meetings: a pricing call yesterday and a launch plan three days ago */
export function chatMeetings(store: Store): string[] {
  const day = 86_400_000
  const add = (title: string, ago: number, who: string, lines: Array<[boolean, string]>, notes: string) => {
    const startedAt = Date.now() - ago
    const m = store.createMeeting({ title, startedAt, endedAt: startedAt + 30 * 60_000, eventId: null, app: null, attendees: [{ name: who, email: null }], state: 'done' })
    store.addSegments(lines.map(([mine, text], i) => ({ meetingId: m.id, track: mine ? 'me' as const : 'them' as const, startMs: i * 65_000, endMs: i * 65_000 + 6000, text, speaker: mine ? null : who })))
    store.setNotes(m.id, { enhanced: notes })
    return m.id
  }
  return [
    add('Pricing call', day, 'Tarun Shah', [[true, 'How much would fifty seats be?'], [false, 'Twenty dollars a seat, billed yearly.'], [true, 'Can we start in December?'], [false, 'Yes, December works for us.']],
      '## Pricing\n- Twenty dollars a seat, billed yearly.\n## Next steps\n- **You:** Send Tarun the signed quote by Friday.'),
    add('Launch planning', 3 * day, 'Bo Park', [[true, 'Where are we with the launch?'], [false, 'The site goes live on Tuesday.'], [false, 'I will write the release notes.']],
      '## Launch\n- The site goes live on Tuesday.\n## Next steps\n- **Bo Park:** Write the release notes.'),
  ]
}
