import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { cloudView, loadSettings, localeOf, notesLanguageSetting, recordingReminderOn, spokenSetting, stopsWhenCallEnds, updateSettings } from './settings'
import type { CloudPatch } from '../shared/cloud'
import { systemLocale } from './locale'
import { PERMISSION_KINDS, type PermissionKind, type Permissions } from './permissions'
import { firstRunPlan, missing, nudge } from '../shared/onboarding'
import type { OnboardingPlan } from '../shared/types'
import { cleanJargon } from '../shared/jargon'
import { isLocale, setLanguage } from '../shared/i18n'
import { isNotesLanguage, isSpoken, type Spoken } from '../shared/spoken'

const isKind = (k: unknown): k is PermissionKind => PERMISSION_KINDS.includes(k as PermissionKind)

/**
 * Settings, the first run (intro and permissions) and home's Finish setup: permissions (read, asked, or their System Settings pane), open at login, theme.
 * ask: whether this run may show the first run at all (fake mode only when a test sets the permissions).
 */
export function hookPreferences(d: { file: string; permissions: Permissions; ask: boolean; setLogin(on: boolean): void; setTrayVisible(on: boolean): void; loginOn(saved: boolean | undefined): boolean; /** the Mac's full name */ macName(): string
  /** quit and open again, for a permission the Mac applies only then; false when it can't now (recording) */
  relaunch(): boolean
  /** fake mode: a slow start, so tests see the launch screen */
  slowStartMs?: number
  /** the spoken language changed: the meeting being recorded follows it where it can */
  onSpoken?: (v: Spoken) => void
  /** seals a secret for the settings file (the cloud model's key); null when this computer can't keep one */
  seal?: (plain: string) => string | null
  /** the permissions this computer has (supportedKinds in platform.ts); a Mac has them all */
  kinds?: readonly PermissionKind[] }) {
  const kinds = d.kinds ?? PERMISSION_KINDS
  let plan: Promise<OnboardingPlan> | undefined
  // asked once per launch, so the list doesn't shrink under the person as they answer
  ipcMain.handle('onboarding:plan', () => (plan ??= (async () => {
    if (d.slowStartMs) await new Promise((r) => setTimeout(r, d.slowStartMs))
    const s = loadSettings(d.file)
    if (!d.ask || s.welcomed) return { intro: false, steps: [] }
    return firstRunPlan({ ask: d.ask, welcomed: !!s.welcomed, introSeen: !!s.introSeen, status: await d.permissions.status(), kinds })
  })()))
  ipcMain.handle('onboarding:intro-seen', () => { updateSettings(d.file, { introSeen: true }) })
  ipcMain.handle('onboarding:done', () => { updateSettings(d.file, { welcomed: true }) })
  // home's Finish setup: what wasn't put away (fake mode, like the first run, only when a test sets the permissions)
  ipcMain.handle('onboarding:nudge', async () => (d.ask ? nudge(await d.permissions.status(), loadSettings(d.file).setupDismissed ?? [], kinds) : []))
  ipcMain.handle('onboarding:dismiss-nudge', async () => {
    updateSettings(d.file, { setupDismissed: missing(await d.permissions.status(), kinds).map((m) => m.kind) })
  })
  ipcMain.handle('onboarding:restore-nudge', () => { updateSettings(d.file, { setupDismissed: [] }) })
  ipcMain.handle('permissions:relaunch', () => d.relaunch())
  ipcMain.handle('permissions:status', () => d.permissions.status())
  ipcMain.handle('permissions:request', (_e, k: unknown) => (isKind(k) ? d.permissions.request(k) : 'unknown'))
  ipcMain.handle('permissions:open', (_e, k: unknown) => { if (isKind(k)) return d.permissions.openSettings(k) })
  ipcMain.handle('settings:get', () => {
    const s = loadSettings(d.file)
    // what the Mac says, so a change in System Settings shows here
    // locale: every window (main, card, widget) shows the interface language
    // language: the one picked ('' is the Mac's); locale: the one in use; systemLocale: the Mac's, for the picker
    return { theme: s.theme ?? 'system', openAtLogin: d.loginOn(s.openAtLogin), showInMenuBar: s.showInMenuBar !== false, language: isLocale(s.language) ? s.language : '', locale: localeOf(s, systemLocale()), systemLocale: systemLocale(), myName: s.myName?.trim() || d.macName(), macName: d.macName(), stopWhenCallEnds: stopsWhenCallEnds(s), recordingReminder: recordingReminderOn(s), jargon: cleanJargon(s.jargon), spoken: spokenSetting(s, systemLocale()), notesLanguage: notesLanguageSetting(s) ?? '', cloud: cloudView(s) }
  })
  // what the person is called in meetings (who "You" is when naming voices); blank: the Mac's full name again
  ipcMain.handle('settings:name', (_e, v: unknown) => {
    if (typeof v !== 'string') return
    const name = v.replace(/\s+/g, ' ').trim().slice(0, 80)
    updateSettings(d.file, { myName: name && name !== d.macName() ? name : undefined })
  })
  // the interface language, applied at once: main's menus and notices, and every open window ('' is the Mac's)
  ipcMain.handle('settings:language', (_e, v: unknown) => {
    if (v !== '' && !isLocale(v)) return
    const locale = localeOf(updateSettings(d.file, { language: v || undefined }), systemLocale())
    setLanguage(locale)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('settings:language', locale)
    return locale
  })
  ipcMain.handle('settings:theme', (_e, v: unknown) => {
    if (v !== 'light' && v !== 'dark' && v !== 'system') return
    nativeTheme.themeSource = v
    updateSettings(d.file, { theme: v === 'system' ? undefined : v })
  })
  // on is the default, so only off is written down
  ipcMain.handle('settings:auto-stop', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    updateSettings(d.file, { stopWhenCallEnds: on ? undefined : false })
  })
  ipcMain.handle('settings:recording-reminder', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    updateSettings(d.file, { recordingReminder: on ? undefined : false })
  })
  // the whole list each time, cleaned the same way the page cleans it; what was kept comes back
  ipcMain.handle('settings:jargon', (_e, v: unknown) => {
    const jargon = cleanJargon(v)
    updateSettings(d.file, { jargon: jargon.length ? jargon : undefined })
    return jargon
  })
  // whatever is picked is written down: with nothing written, it follows the computer's language
  ipcMain.handle('settings:spoken', (_e, v: unknown) => {
    if (!isSpoken(v)) return
    updateSettings(d.file, { spoken: v })
    d.onSpoken?.(v)
  })
  // '': the meeting's own language again, which is nothing written down
  ipcMain.handle('settings:notes-language', (_e, v: unknown) => {
    if (v !== '' && !isNotesLanguage(v)) return
    updateSettings(d.file, { notesLanguage: v === '' ? undefined : v })
  })
  // The cloud model: on or off, its address, its model and its key. The key is sealed before it is written down
  // and never sent back to the window; on a computer that cannot seal one it is not kept at all.
  ipcMain.handle('settings:cloud', (_e, v: unknown) => {
    if (!v || typeof v !== 'object') return
    const p = v as CloudPatch, cloud = { ...loadSettings(d.file).cloud }
    if (typeof p.on === 'boolean') cloud.on = p.on || undefined
    if (typeof p.url === 'string') cloud.url = p.url.trim().slice(0, 500) || undefined
    if (typeof p.model === 'string') cloud.model = p.model.trim().slice(0, 200) || undefined
    if (typeof p.key === 'string') cloud.key = (p.key.trim() && d.seal?.(p.key.trim())) || undefined
    const s = updateSettings(d.file, { cloud: Object.values(cloud).some((x) => x !== undefined) ? cloud : undefined })
    return cloudView(s)
  })
  ipcMain.handle('settings:menu-bar', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    updateSettings(d.file, { showInMenuBar: on ? undefined : false })
    d.setTrayVisible(on)
  })
  ipcMain.handle('settings:login', (_e, on: unknown) => {
    const yes = on === true
    updateSettings(d.file, { openAtLogin: yes })
    d.setLogin(yes)
  })
}

