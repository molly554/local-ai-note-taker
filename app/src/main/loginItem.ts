import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix } from 'node:path'
import { PRODUCT } from '../shared/brand'

type MacStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'

/**
 * At launch: put the login item back only when the person wants it and the Mac lost it (Yogurt moved or reinstalled).
 * Turned off in System Settings, or waiting for their approval there: theirs to decide, left alone.
 */
export function loginOnStart(wanted: boolean | undefined, status: MacStatus): 'register' | 'unregister' | 'none' {
  if (wanted === true && (status === 'not-registered' || status === 'not-found')) return 'register'
  if (wanted === false && status === 'enabled') return 'unregister'
  return 'none'
}

/** Windows: Yogurt starts at login with --hidden, so it waits in the tray with no window, like a Mac's login launch */
export const WINDOWS_LOGIN = { args: ['--hidden'] }

/** Windows at launch: the entry follows the saved choice. Turned off in Task Manager keeps the entry, so that stays theirs. */
export function pcLoginOnStart(wanted: boolean | undefined, on: boolean): 'register' | 'unregister' | 'none' {
  if (wanted === true && !on) return 'register'
  if (wanted === false && on) return 'unregister'
  return 'none'
}

/** Linux: the XDG autostart entry (GNOME, KDE and the rest read ~/.config/autostart) */
export const autostartFile = (env: Record<string, string | undefined>, home: string): string =>
  posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'autostart', 'yogurt.desktop')

/** The entry: the AppImage, quoted the Desktop Entry way (any path, spaces and % included), started hidden */
export function autostartEntry(appImage: string): string {
  const quoted = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%')
  return `[Desktop Entry]\nType=Application\nName=${PRODUCT}\nExec=${quoted} --hidden\nX-GNOME-Autostart-enabled=true\n`
}

/** on when the entry is there and not hidden (a desktop's startup settings may hide it instead of removing it) */
export const autostartOn = (existing: string | null): boolean => existing !== null && !/^Hidden=true$/m.test(existing)

/**
 * Linux at launch: an entry for a moved AppImage points at the new one; an entry the person removed or hid
 * is never brought back (as on a Mac, turned off is theirs to decide).
 */
export function autostartPlan(wanted: boolean | undefined, existing: string | null, entry: string): 'write' | 'remove' | 'none' {
  if (wanted === true && autostartOn(existing) && existing !== entry) return 'write'
  if (wanted === false && existing !== null) return 'remove'
  return 'none'
}

const os = process.platform
/** Only a real, installed Yogurt touches login items (a dev or test run would register Electron itself); on Linux only the AppImage */
const real = () => app.isPackaged && (os === 'darwin' || os === 'win32' || (os === 'linux' && !!process.env.APPIMAGE))

const file = () => autostartFile(process.env, homedir())
const readEntry = (): string | null => { try { return existsSync(file()) ? readFileSync(file(), 'utf8') : null } catch { return null } }
function writeEntry() {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(`${file()}.tmp`, autostartEntry(process.env.APPIMAGE!))
  renameSync(`${file()}.tmp`, file())
}

export function setLoginItem(on: boolean) {
  if (!real()) return
  if (os === 'linux') {
    try { if (on) writeEntry(); else rmSync(file(), { force: true }) } catch (error) { console.warn('could not change the autostart entry', error) }
  } else app.setLoginItemSettings(os === 'win32' ? { openAtLogin: on, ...WINDOWS_LOGIN } : { openAtLogin: on })
}
/** What the computer says now; the saved choice off a real install */
export function loginItemOn(saved: boolean | undefined): boolean {
  if (!real()) return !!saved
  if (os === 'linux') return autostartOn(readEntry())
  return (os === 'win32' ? app.getLoginItemSettings(WINDOWS_LOGIN) : app.getLoginItemSettings()).openAtLogin
}
export function syncLoginItem(saved: boolean | undefined) {
  if (!real()) return
  if (os === 'linux') {
    const act = autostartPlan(saved, readEntry(), autostartEntry(process.env.APPIMAGE!))
    if (act !== 'none') setLoginItem(act === 'write')
    return
  }
  const act = os === 'win32' ? pcLoginOnStart(saved, app.getLoginItemSettings(WINDOWS_LOGIN).openAtLogin) : loginOnStart(saved, app.getLoginItemSettings().status)
  if (act !== 'none') setLoginItem(act === 'register')
}
/** opened by the Mac at login: start in the menu bar, no window (Windows and Linux start with --hidden: startedHidden) */
export const openedAtLogin = (): boolean => os === 'darwin' && real() && app.getLoginItemSettings().wasOpenedAtLogin
