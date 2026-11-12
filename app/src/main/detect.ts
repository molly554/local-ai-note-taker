import type { CalEvent } from './calendar'

export type MicApp = { bundleId: string; name: string; /** the window's title, when known */ title?: string }
export type Signals = { micApps: MicApp[]; events: CalEvent[]; recording: boolean; /** owners confirmed by NSRunningApplication */ runningApps?: string[] }
export type Prompt = { key: string; /** the event's title; empty with no event (the window words it) */ title: string; app: string | null; event: CalEvent | null }
/** keys of prompts the person closed */
export type Dismissals = ReadonlySet<string>

const MIN = 60_000

type CallApp = { id: string; name: string; browser?: boolean }
// Apps that make calls. Browsers only count with a sign of a call (see decide).
const MAC_APPS: CallApp[] = [
  { id: 'us.zoom.xos', name: 'Zoom' },
  { id: 'com.microsoft.teams', name: 'Teams' },
  { id: 'com.microsoft.teams2', name: 'Teams' }, // the new Teams
  { id: 'com.cisco.webexmeetingsapp', name: 'Webex' },
  { id: 'Cisco-Systems.Spark', name: 'Webex' },
  { id: 'com.apple.FaceTime', name: 'FaceTime' },
  { id: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  { id: 'com.hnc.Discord', name: 'Discord' },
  { id: 'net.whatsapp.WhatsApp', name: 'WhatsApp' },
  { id: 'WhatsApp', name: 'WhatsApp' }, // legacy desktop app
  { id: 'com.google.Chrome', name: 'Chrome', browser: true },
  { id: 'company.thebrowser.Browser', name: 'Arc', browser: true },
  { id: 'com.apple.Safari', name: 'Safari', browser: true },
  { id: 'com.microsoft.edgemac', name: 'Edge', browser: true },
  { id: 'org.mozilla.firefox', name: 'Firefox', browser: true },
  { id: 'com.brave.Browser', name: 'Brave', browser: true },
]
// Non-child bundle IDs used by known audio helpers; ownership still needs a running app.
const MAC_HELPERS: Record<string, string> = {
  'us.zoom.CptHost': 'us.zoom.xos',
  'com.apple.avconferenced': 'com.apple.FaceTime',
  'WhatsApp-Helper': 'WhatsApp',
  'org.mozilla.plugincontainer': 'org.mozilla.firefox',
  'com.apple.WebKit.WebContent': 'com.apple.Safari',
  'com.apple.WebKit.GPU': 'com.apple.Safari',
}
const named = (name: string, ids: string[], browser?: boolean): CallApp[] => ids.map((id) => ({ id, name, ...(browser ? { browser } : {}) }))
/**
 * yogurt-system names an app by its program on Windows (lowercase .exe; Edge WebView2 already resolved to the app that
 * owns it) and on Linux by its Flatpak or portal id, else its program. Google Meet is a browser call everywhere.
 */
const APPS_BY_OS: Record<string, CallApp[]> = {
  darwin: MAC_APPS,
  win32: [
    ...named('Zoom', ['zoom.exe']), ...named('Teams', ['ms-teams.exe', 'teams.exe']),
    ...named('Webex', ['webex.exe', 'ciscocollabhost.exe', 'atmgr.exe', 'webexmta.exe']), ...named('Slack', ['slack.exe']),
    ...named('Discord', ['discord.exe']), ...named('WhatsApp', ['whatsapp.exe', 'whatsapp.root.exe']),
    ...named('Chrome', ['chrome.exe'], true), ...named('Edge', ['msedge.exe'], true), ...named('Firefox', ['firefox.exe'], true),
    ...named('Brave', ['brave.exe'], true), ...named('Arc', ['arc.exe'], true), ...named('Opera', ['opera.exe'], true), ...named('Vivaldi', ['vivaldi.exe'], true),
  ],
  linux: [
    ...named('Zoom', ['zoom', 'us.zoom.Zoom']), ...named('Teams', ['teams-for-linux', 'com.github.IsmaelMartinez.teams_for_linux']),
    ...named('Slack', ['slack', 'com.slack.Slack']), ...named('Discord', ['Discord', 'discord', 'com.discordapp.Discord']), ...named('Webex', ['CiscoCollabHost', 'webex']),
    ...named('Chrome', ['chrome', 'google-chrome', 'com.google.Chrome'], true), ...named('Chromium', ['chromium', 'chromium-browser', 'org.chromium.Chromium'], true),
    ...named('Firefox', ['firefox', 'firefox-bin', 'org.mozilla.firefox'], true), ...named('Brave', ['brave', 'com.brave.Browser'], true),
    ...named('Edge', ['msedge', 'com.microsoft.Edge'], true), ...named('Vivaldi', ['vivaldi-bin'], true), ...named('Opera', ['opera'], true),
  ],
}
const HELPERS_BY_OS: Record<string, Record<string, string>> = {
  darwin: MAC_HELPERS,
  win32: { 'cpthost.exe': 'zoom.exe', 'zoomwebviewhost.exe': 'zoom.exe' },
  linux: {},
}
/** Yogurt's own recorder holds the mic while it records; yogurt-system lists it like any app off a Mac */
const OWN_BY_OS: Record<string, string[]> = { darwin: [], win32: ['yogurt-audio.exe', 'yogurt.exe'], linux: ['yogurt-audio', 'yogurt', 'Yogurt'] }
let APPS = MAC_APPS
let HELPERS = MAC_HELPERS
let OWN: string[] = []
/** The call apps of this computer (index.ts, once); a Mac's are the default */
export function useCallApps(platform: string) {
  APPS = APPS_BY_OS[platform] ?? MAC_APPS
  HELPERS = HELPERS_BY_OS[platform] ?? MAC_HELPERS
  OWN = OWN_BY_OS[platform] ?? []
}
/** Yogurt's own recorder (or Yogurt) on the mic: never a call */
export const isOwnMicApp = (bundleId: string): boolean => OWN.includes(bundleId)
const appOf = (bundleId: string) => {
  if (OWN.includes(bundleId)) return undefined
  const id = Object.entries(HELPERS).find(([helper]) => bundleId === helper || bundleId.startsWith(helper + '.'))?.[1] ?? bundleId
  return APPS.find((a) => id === a.id || id.startsWith(a.id + '.'))
}
/** Candidate owner to check with NSRunningApplication, never inferred from a process name. */
export const callAppId = (bundleId: string): string | null => appOf(bundleId)?.id ?? null
const micApp = (bundleId: string, runningApps: readonly string[] = []) => {
  const app = appOf(bundleId)
  return app && (bundleId === app.id || runningApps.includes(app.id)) ? app : undefined
}
/** Helpers count only while their owning app is running. Direct app mic holders prove their own presence. */
export const callAppName = (bundleId: string, runningApps?: readonly string[]): string | null => micApp(bundleId, runningApps)?.name ?? null

/** The browser to ask for the front tab's name when this process is on the mic; null for apps that are not browsers */
export const tabTitleApp = (bundleId: string): string | null => {
  const a = appOf(bundleId)
  return a?.browser ? a.id : null
}

const WEB_CALL = /\b(meet|teams|zoom)\b/i

/** the event this moment belongs to: starts within 10 minutes either way, not over; one with a call link first */
export function matchEvent(events: CalEvent[], now: number): CalEvent | null {
  const near = events.filter((e) => Math.abs(e.start - now) <= 10 * MIN && e.end > now)
  near.sort((a, b) => Number(!!b.url) - Number(!!a.url) || Math.abs(a.start - now) - Math.abs(b.start - now))
  return near[0] ?? null
}

/** Should Yogurt offer to take notes now? A call app using the mic is the trigger; a meeting on the calendar alone waits for the call. */
export function decide(s: Signals, now: number, recent: Dismissals): Prompt | null {
  if (s.recording) return null
  const event = matchEvent(s.events, now)
  for (const m of s.micApps) {
    const app = micApp(m.bundleId, s.runningApps)
    if (!app) continue
    if (app.browser && !event?.url && !(m.title && WEB_CALL.test(m.title))) continue
    // one meeting, one key: the event's, else the app's
    const key = event ? `event:${event.id}:${event.start}` : `app:${app.id}`
    if (recent.has(key)) continue
    return { key, title: event?.title ?? '', app: app.name, event }
  }
  return null
}

/**
 * Has the meeting ended? micIdleMs: how long the meeting's app has not used the mic (0 while it does).
 * Also ended: the event is 5 minutes over and both tracks have been quiet for 60 s. This only asks; callGone is what stops by itself.
 */
export function ended(_s: Signals, micIdleMs: number, ctx?: { event: CalEvent | null; silentMs: number; now: number }): boolean {
  if (micIdleMs >= 30_000) return true
  return !!ctx?.event && ctx.now >= ctx.event.end + 5 * MIN && ctx.silentMs >= 60_000
}

/** How long the call app must be off the mic before a recording stops by itself: reconnecting, a new headset or Zoom's own mute let go for a moment */
export const CALL_GONE_MS = 10_000

/**
 * Should the recording stop by itself? Only one tied to a call app (app) that was on the mic during this recording (seen),
 * once that app has let go of the mic for the grace. A recording that never observes a call, or a resumed note whose call is over, never.
 * The calendar never stops one: meetings run over.
 */
export function callGone(o: { app: string | null; seen: boolean; micIdleMs: number; graceMs?: number }): boolean {
  return !!o.app && o.seen && o.micIdleMs >= (o.graceMs ?? CALL_GONE_MS)
}
