import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isLocale } from '../shared/i18n'
import { isNotesLanguage, spokenOf, type NotesLanguage, type Spoken } from '../shared/spoken'

/** theme: light or dark regardless of the system; follows the system when left out. language: the interface's, the computer's when left out */
export type Settings = { theme?: 'light' | 'dark'; language?: string; /** what the person is called in their meetings; their Mac's full name when left out */ myName?: string
  /** the first-run questions were shown (answered or put off): never asked again */
  welcomed?: boolean
  /** the intro screens were read or skipped (kept apart, so a restart halfway through goes on with the permissions) */
  introSeen?: boolean
  /** home's Finish setup was put away while these were missing; it comes back only when something else is */
  setupDismissed?: import('./permissions').PermissionKind[]
  /** opens when the Mac starts; off unless the person said yes */
  openAtLogin?: boolean
  /** the native menu bar icon; on unless turned off */
  showInMenuBar?: boolean
  /** Legacy flag, ignored: it may have come from a different app bundle. Removed after a confirmed post. */
  notificationsAsked?: boolean
  /** Designated requirements of app identities that successfully posted the registering notification. Not authorization. */
  notificationsAskedFor?: string[]
  /** Accessibility was asked for once (the Mac's prompt shows only the first time; after it, only System Settings) */
  axAsked?: boolean
  /** AI apps on this Mac (Claude, Cursor, …) may read meetings through MCP; off unless the person turned it on */
  aiApps?: boolean
  /** a recording stops by itself when its call ends; on unless turned off (false: ask first) */
  stopWhenCallEnds?: boolean
  /** a quiet reminder to ask everyone before recording; on unless turned off */
  recordingReminder?: boolean
  /** the mic to record with (its Core Audio UID); Auto, the Mac's own input, when left out or not plugged in */
  mic?: string
  /** Calendars excluded from Yogurt's agenda and meeting detection. Others stay visible. */
  hiddenCalendarIds?: string[]
  /** names, products and acronyms to spell right in transcripts and notes (shared/jargon.ts) */
  jargon?: string[]
  /** the language people speak in meetings (shared/spoken.ts); left out, the computer's own when it can be picked, else English only */
  spoken?: Spoken
  /** the language notes are written in (shared/spoken.ts); the meeting's own when left out */
  notesLanguage?: NotesLanguage
  /** new versions download by themselves; on unless turned off */
  autoUpdate?: boolean }

/** the spoken language picked; with none, the computer's own (system: its locale) when it can be picked, else "English only" */
export const spokenSetting = (s: Settings, system = ''): Spoken => spokenOf(s.spoken, system)
/** the language notes are to be written in; null: each meeting's own */
export const notesLanguageSetting = (s: Settings): NotesLanguage | null => (isNotesLanguage(s.notesLanguage) ? s.notesLanguage : null)

/** "Finish recording when the call ends": on by default */
export const stopsWhenCallEnds = (s: Settings): boolean => s.stopWhenCallEnds !== false
export const recordingReminderOn = (s: Settings): boolean => s.recordingReminder !== false
export const autoUpdateOn = (s: Settings): boolean => s.autoUpdate !== false

export function loadSettings(path: string): Settings {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {} } catch { return {} }
}
export function saveSettings(path: string, s: Settings) {
  // write-then-rename so a crash mid-save never leaves a half-written file
  writeFileSync(path + '.tmp', JSON.stringify(s, null, 2))
  renameSync(path + '.tmp', path)
}

/** Merge a patch into the saved settings; undefined values remove a key. */
export function updateSettings(path: string, patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(path), ...patch }
  saveSettings(path, next)
  return next
}

/** The language picked in Settings; the computer's when none (or one Yogurt no longer has) */
export const localeOf = (s: Settings, system: string): string => (isLocale(s.language) ? s.language : system)
