import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isLocale } from '../shared/i18n'
import { isNotesLanguage, spokenOf, type NotesLanguage, type Spoken } from '../shared/spoken'
import { cleanExtra, isTemplate, type NotesStyle, type Template } from '../shared/templates'
import { cloudAddress, type Cloud, type CloudView } from '../shared/cloud'

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
  /** the template Summaries are written with (shared/templates.ts); 'general' when left out */
  template?: Template
  /** what people will do goes at the top of a Summary; at the end when left out */
  nextStepsFirst?: boolean
  /** what the person asks of every Summary, in their own words */
  notesExtra?: string
  /** a cloud model for the writing (shared/cloud.ts): off unless turned on. key: as the system's store sealed it, never the key itself */
  cloud?: { on?: boolean; url?: string; model?: string; key?: string }
  /** new versions download by themselves; on unless turned off */
  autoUpdate?: boolean }

/** the spoken language picked; with none, the computer's own (system: its locale) when it can be picked, else "English only" */
export const spokenSetting = (s: Settings, system = ''): Spoken => spokenOf(s.spoken, system)
/** the language notes are to be written in; null: each meeting's own */
export const notesLanguageSetting = (s: Settings): NotesLanguage | null => (isNotesLanguage(s.notesLanguage) ? s.notesLanguage : null)
/** how Summaries are written. own: the template a meeting has of its own, which wins over the one picked here */
export const notesStyleSetting = (s: Settings, own?: string | null): NotesStyle => ({
  template: isTemplate(own) ? own : isTemplate(s.template) ? s.template : 'general', nextStepsFirst: s.nextStepsFirst === true, extra: cleanExtra(s.notesExtra),
})
/** the cloud model to write with: only when it is turned on, its address can be sent to, and its model and key are there. open: unseals the key */
export const cloudSetting = (s: Settings, open: (kept: string) => string | null): Cloud | null => {
  const c = s.cloud, url = cloudAddress(c?.url), model = c?.model?.trim()
  if (!c?.on || !url || !model || !c.key) return null
  const key = open(c.key)
  return key ? { url, model, key } : null
}
/** what Settings shows of it: never the key */
export const cloudView = (s: Settings): CloudView => ({ on: !!s.cloud?.on, url: s.cloud?.url ?? '', model: s.cloud?.model ?? '', hasKey: !!s.cloud?.key })

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
