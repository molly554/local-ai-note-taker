import type { Helper } from './calendar'

/**
 * What Yogurt may use. unknown: not asked yet. restricted: the Mac is managed by an organisation, which decides.
 * asked: notifications only, requested already (this bridge does not read the person's answer).
 */
export type Access = 'granted' | 'denied' | 'unknown' | 'restricted' | 'asked'
/** accessibility: optional, for names from calls (callNames): who is talking in Zoom, Meet and Teams */
export type PermissionKind = 'mic' | 'systemAudio' | 'calendar' | 'notifications' | 'accessibility'
export type PermissionStatus = Record<PermissionKind, Access>
export const PERMISSION_KINDS: PermissionKind[] = ['mic', 'systemAudio', 'calendar', 'notifications', 'accessibility']

/** The pane of System Settings where each one is turned on */
export const SETTINGS_URL: Record<PermissionKind, string> = {
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  // "Screen & System Audio Recording": the audio-only list sits at its bottom
  systemAudio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
}

/**
 * yogurt-mac permissions says: mic as AVFoundation names it (authorized, denied, restricted, notDetermined),
 * systemAudio as TCC's preflight number (0 allowed, 1 denied, 2 not asked), calendar as the helper's calendar-status,
 * accessibility as true or false only (the Mac never says whether it was asked: axAsked, Yogurt's own memory, tells).
 */
export function parseStatus(raw: unknown, o: { axAsked?: boolean } = {}): Omit<PermissionStatus, 'notifications'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mic: Access = r.mic === 'authorized' ? 'granted' : r.mic === 'denied' ? 'denied' : r.mic === 'restricted' ? 'restricted' : 'unknown'
  const systemAudio: Access = r.systemAudio === 0 ? 'granted' : r.systemAudio === 1 ? 'denied' : 'unknown'
  const calendar: Access = r.calendar === 'granted' ? 'granted' : r.calendar === 'denied' ? 'denied' : r.calendar === 'restricted' ? 'restricted' : 'unknown'
  const accessibility: Access = r.accessibility === true ? 'granted' : r.accessibility === false && o.axAsked ? 'denied' : 'unknown'
  return { mic, systemAudio, calendar, accessibility }
}

/** Windows' own pages for these (Linux has none): a mic blocked under Privacy & security is turned on there */
const WINDOWS_SETTINGS: Partial<Record<PermissionKind, string>> = { mic: 'ms-settings:privacy-microphone', notifications: 'ms-settings:notifications' }

const ASK: Record<Exclude<PermissionKind, 'notifications'>, string> = { mic: 'mic-auth', systemAudio: 'audio-auth', calendar: 'calendar-auth', accessibility: 'ax-auth' }

/**
 * Reads and asks for what Yogurt needs. The helper asks with the Mac's own prompts; notifications go through Electron,
 * whose first notification makes the Mac ask. Nothing here throws: a helper that fails reads as unknown.
 */
export function createPermissions(d: { helper: Helper; notifications(): Access | Promise<Access>; askNotifications(): Promise<Access>; open(url: string): void
  /** Accessibility was asked for once already (the Mac's prompt only shows the first time) */
  axAsked?: () => boolean; setAxAsked?: () => void
  /** the computer (default a Mac); Windows and Linux ask nothing (see offMac) */
  platform?: string
  /** Windows: the last recording said the mic is blocked (the recorder's no-mic) */
  micBlocked?: () => boolean }) {
  if (d.platform && d.platform !== 'darwin') return offMac(d.platform, d.open, d.micBlocked)
  const status = async (): Promise<PermissionStatus> => {
    let raw: unknown = null
    try { raw = await d.helper(['permissions']) } catch { /* no helper: nothing known */ }
    return { ...parseStatus(raw, { axAsked: d.axAsked?.() }), notifications: await d.notifications() }
  }
  return {
    status,
    async request(kind: PermissionKind): Promise<Access> {
      if (kind === 'notifications') return d.askNotifications().catch(() => 'unknown' as const)
      try { await d.helper([ASK[kind]]) } catch { return 'unknown' }
      if (kind === 'accessibility') d.setAxAsked?.()
      return (await status())[kind]
    },
    async openSettings(kind: PermissionKind) {
      if (kind === 'accessibility') {
        // A saved "asked" flag may belong to a prior app identity; register this one before showing its pane.
        try { await d.helper(['ax-auth']); d.setAxAsked?.() } catch { /* Settings is still useful if the helper fails. */ }
      }
      d.open(SETTINGS_URL[kind])
    },
  }
}
export type Permissions = ReturnType<typeof createPermissions>

/**
 * Windows and Linux have no prompts to ask with: the mic, call audio and notifications are simply on. Windows can still
 * block desktop apps from the mic; the recorder finds that out when it starts (no-mic), and the mic reads as off until a
 * recording hears it again. Its Settings page opens from the hint. Calendar and Accessibility don't exist there.
 */
function offMac(platform: string, open: (url: string) => void, micBlocked?: () => boolean) {
  const status = async (): Promise<PermissionStatus> =>
    ({ mic: platform === 'win32' && micBlocked?.() ? 'denied' : 'granted', systemAudio: 'granted', calendar: 'unknown', notifications: 'granted', accessibility: 'unknown' })
  return {
    status,
    async request(kind: PermissionKind): Promise<Access> { return (await status())[kind] },
    async openSettings(kind: PermissionKind) {
      const url = platform === 'win32' ? WINDOWS_SETTINGS[kind] : undefined
      if (url) open(url)
    },
  }
}
