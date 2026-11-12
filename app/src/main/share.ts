import { app, clipboard, ClipboardItem, dialog, ipcMain, type BrowserWindow } from 'electron'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileNameFor, toClipboard, toMarkdownFile, transcriptClipboard } from '../shared/exportNotes'
import type { Store } from './store'
import { isFake } from './paths'
import { t } from '../shared/i18n'

type Side = 'mine' | 'enhanced'
/** the notes on the side shown, falling back to the person's own when the enhanced ones are not there */
function notesOf(store: Pick<Store, 'notes'>, id: string, side: unknown): string {
  const n = store.notes(id)
  return side === 'enhanced' && n.enhanced != null ? n.enhanced : n.mine
}

/**
 * Copy and export. The window only says which meeting and which side; the text is built here from what is saved,
 * and the file goes where the save dialog says, never to a path the window made up.
 */
export function hookShare(d: { store: Pick<Store, 'meeting' | 'notes' | 'segments'>; window: () => BrowserWindow | undefined }) {
  ipcMain.handle('share:copy', async (_e, id: unknown, what: unknown, side: unknown): Promise<'copied' | 'nothing' | 'failed'> => {
    if (typeof id !== 'string' || (what !== 'notes' && what !== 'transcript')) return 'nothing'
    const data = what === 'transcript'
      ? transcriptClipboard(d.store.segments(id))
      : toClipboard(notesOf(d.store, id, side))
    if (!data.text.trim()) return 'nothing'
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': data.text, 'text/html': data.html })])
      return 'copied'
    } catch (err) {
      console.error('copy failed', err)
      return 'failed'
    }
  })
  ipcMain.handle('share:save', async (_e, id: unknown, side: unknown): Promise<'saved' | 'cancelled' | 'failed'> => {
    const m = typeof id === 'string' ? d.store.meeting(id) : undefined
    if (!m) return 'failed'
    // tests name the file themselves; people get the Mac's save panel
    let path: string | undefined = isFake() ? process.env.YOGURT_EXPORT_PATH : undefined
    if (!path) {
      const opts = { title: t('Export as Markdown'), defaultPath: join(app.getPath('documents'), fileNameFor(m.title, m.startedAt)), filters: [{ name: 'Markdown', extensions: ['md'] }] }
      const win = d.window()
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return 'cancelled'
      path = r.filePath
    }
    let staging: string | undefined
    try {
      // Stage on the destination's filesystem: a failed write must not truncate an earlier export.
      staging = await mkdtemp(join(dirname(path), '.yogurt-export-'))
      const file = join(staging, 'notes.md')
      await writeFile(file, toMarkdownFile(m, notesOf(d.store, m.id, side as Side), d.store.segments(m.id)), 'utf8')
      await rename(file, path)
      return 'saved'
    } catch (err) {
      console.error('export failed', err)
      return 'failed'
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch((err) => console.warn('export cleanup failed', err))
    }
  })
}
