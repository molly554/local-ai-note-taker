import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { exportBackup, importBackup } from './backup'
import { isFake } from './paths'
import { t } from '../shared/i18n'

const pad = (n: number) => String(n).padStart(2, '0')
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Backup in Settings. The window only says export or import; the file always comes from the Mac's own save or open
 * panel (tests name it with YOGURT_BACKUP_PATH), and Show in Finder shows only the file just written.
 */
export function hookBackup(d: { db: DatabaseSync; meetingsDir: string; window: () => BrowserWindow | undefined; recording: () => boolean; changed: () => void; beforeExport: () => string | undefined }) {
  let last: string | undefined
  const fakePath = () => (isFake() ? process.env.YOGURT_BACKUP_PATH : undefined)
  ipcMain.handle('backup:status', () => ({ recording: d.recording() }))
  ipcMain.handle('backup:export', async () => {
    try {
      let unsaved = d.beforeExport()
      if (unsaved) return { ok: false, error: 'unsaved', meetingId: unsaved }
      let path = fakePath()
      if (!path) {
        const opts = { title: t('Export all notes'), defaultPath: join(app.getPath('documents'), `Yogurt backup ${today()}.zip`), filters: [{ name: 'Zip', extensions: ['zip'] }] }
        const win = d.window()
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' }
        path = r.filePath
      }
      // A save panel is asynchronous; recheck before taking the database snapshot.
      if (d.recording()) return { ok: false, error: 'recording' }
      unsaved = d.beforeExport()
      if (unsaved) return { ok: false, error: 'unsaved', meetingId: unsaved }
      const r = await exportBackup({ db: d.db, meetingsDir: d.meetingsDir, out: path, appVersion: app.getVersion() })
      last = path
      return { ok: true, meetings: r.meetings }
    } catch (e) {
      console.error('backup export failed', e)
      return { ok: false, error: 'failed' }
    }
  })
  ipcMain.handle('backup:import', async () => {
    try {
      // a recording writes into the database all the time: one thing at a time
      if (d.recording()) return { ok: false, error: 'recording' }
      let path = fakePath()
      if (!path) {
        const opts = { title: t('Import notes'), defaultPath: app.getPath('documents'), properties: ['openFile' as const], filters: [{ name: 'Zip', extensions: ['zip'] }] }
        const win = d.window()
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
        path = r.filePaths[0]
      }
      if (d.recording()) return { ok: false, error: 'recording' }
      const r = await importBackup({ db: d.db, meetingsDir: d.meetingsDir, zip: path })
      if (r.ok && r.added) {
        try { d.changed() } catch (e) { console.warn('backup imported; window refresh failed', e) }
      }
      return r
    } catch (e) {
      console.error('backup import failed', e)
      return { ok: false, error: 'failed' }
    }
  })
  ipcMain.on('backup:show', () => { if (last && !isFake()) shell.showItemInFolder(last) })
}
