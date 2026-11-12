import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { t } from '../shared/i18n'
import type { UpdateStatus } from '../shared/types'
import { autoUpdateOn, loadSettings, updateSettings } from './settings'

/** checking again while Yogurt stays open for days */
const EVERY_MS = 4 * 60 * 60 * 1000

/**
 * Installed copies update themselves from GitHub Releases (latest-mac.yml, latest.yml for the Windows installer,
 * latest-linux.yml). Not while developing, testing, or on a separate profile; on Linux only the AppImage can replace itself.
 * Never in a preview build (preview.yml by hand): it was never released, so there is nothing to look for.
 */
export function updatesOn(o: { packaged: boolean; fake: boolean; profile: boolean; feed: boolean; platform?: string; appImage?: boolean; preview?: boolean }): boolean {
  return o.packaged && !o.fake && !o.profile && o.feed && !o.preview && (o.platform !== 'linux' || !!o.appImage)
}

/** preview.yml marks a build made by hand (not for a release) in the packaged package.json */
export const isPreviewBuild = (packageJson: string): boolean => {
  try { return JSON.parse(packageJson).yogurtPreview === true } catch { return false }
}

let updater: AppUpdater | undefined
let installOnQuit = false

/** After quit, installs a downloaded version and reopens if that was requested via Settings. */
export function finishQuit(): void {
  if (installOnQuit && updater) updater.quitAndInstall(true, true)
  else app.quit()
}

/**
 * Settings → Updates: the version, what the updater is doing, the on/off switch, and Restart Yogurt once a version is ready.
 * available: false in a build that never updates (see updatesOn); Settings then shows only the version.
 * DOES NOT WORK WHILE RECORDING.
 */
export async function hookUpdates(d: { file: string; available: boolean; recording(): boolean }): Promise<void> {
  let state: UpdateStatus['state'] = 'idle'
  let next: string | undefined
  const status = (): UpdateStatus => ({ version: app.getVersion(), available: d.available, on: autoUpdateOn(loadSettings(d.file)), state, next })
  const set = (s: UpdateStatus['state'], version?: string) => {
    state = s
    if (version) next = version
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updates:status', status())
  }

  ipcMain.handle('updates:status', status)
  ipcMain.handle('updates:set', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return status()
    updateSettings(d.file, { autoUpdate: on ? undefined : false })
    // off means off: a version that already downloaded doesn't install on quit either (Restart Yogurt still can)
    if (updater) updater.autoInstallOnAppQuit = on
    if (on) check()
    return status()
  })
  ipcMain.handle('updates:check', () => { check() })
  ipcMain.handle('updates:restart', () => {
    if (state !== 'ready' || d.recording()) return false
    installOnQuit = true
    app.quit()
    return true
  })

  const check = () => { if (updater && autoUpdateOn(loadSettings(d.file)) && state !== 'ready') updater.checkForUpdates().catch(() => {}) }
  if (!d.available) return

  // loaded here: it reads Electron's app as it loads, which tests don't have
  updater = (await import('electron-updater')).default.autoUpdater
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = autoUpdateOn(loadSettings(d.file))
  updater.logger = null
  updater.on('checking-for-update', () => set('checking'))
  updater.on('update-not-available', () => set('latest'))
  updater.on('update-available', (info) => set('downloading', info.version))
  updater.on('update-downloaded', (info) => {
    set('ready', info.version)
    if (!Notification.isSupported()) return
    new Notification({ title: t('Yogurt {version} is ready', { version: info.version }), body: t('It installs the next time you quit Yogurt.') }).show()
  })
  updater.on('error', (err) => {
    console.warn('checking for a new version failed', err.message)
    set('error')
  })
  setTimeout(check, 30_000)
  setInterval(check, EVERY_MS)
}
