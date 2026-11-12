import { isFolderAppearance } from '../shared/folderAppearance'
import { ipcMain } from 'electron'
import { isId, text } from './ipcArgs'
import type { Store } from './store'

/**
 * Folders: named folders of meetings, from the sidebar, a note's menu and its header chip. Every change tells the
 * windows (changed), so the sidebar, a folder's page and an open note all follow.
 */
export function hookFolders(d: { store: Store; changed: () => void }) {
  const { store } = d
  const folder = (id: unknown): id is string => isId(id) && !!store.folder(id)
  const meeting = (id: unknown): id is string => isId(id) && !!store.meeting(id)
  ipcMain.handle('folders:suggestion', (_e, id: unknown) => {
    if (!meeting(id) || store.meeting(id)?.trashedAt != null || store.foldersOf(id).length) return null
    const s = store.folderSuggestion(id)
    return s.state === 'pending' && s.folderId ? store.folder(s.folderId) ?? null : null
  })
  ipcMain.handle('folders:dismiss-suggestion', (_e, id: unknown) => {
    if (meeting(id)) { store.dismissFolderSuggestion(id); d.changed() }
  })
  ipcMain.handle('folders:list', () => store.folders())
  ipcMain.handle('folders:reorder', (_e, ids: unknown) => {
    if (!Array.isArray(ids) || !ids.every(isId) || !store.reorderFolders(ids)) return false
    d.changed(); return true
  })
  ipcMain.handle('folders:of', (_e, id: unknown) => (isId(id) ? store.foldersOf(id) : []))
  ipcMain.handle('folders:create', (_e, name: unknown, appearance?: unknown) => {
    const n = text(name, 200)
    if (!n?.trim() || (appearance !== undefined && !isFolderAppearance(appearance))) return undefined
    const s = store.createFolder(n, appearance)
    d.changed()
    return s
  })
  ipcMain.handle('folders:appearance', (_e, id: unknown, appearance: unknown) => {
    if (!folder(id) || !isFolderAppearance(appearance)) return false
    store.setFolderAppearance(id, appearance); d.changed(); return true
  })
  ipcMain.handle('folders:rename', (_e, id: unknown, name: unknown) => {
    const n = text(name, 200)
    if (!folder(id) || !n?.trim()) return
    store.renameFolder(id, n); d.changed()
  })
  // its meetings stay
  ipcMain.handle('folders:delete', (_e, id: unknown) => { if (folder(id)) { store.deleteFolder(id); d.changed() } })
  ipcMain.handle('folders:add', (_e, id: unknown, meetingId: unknown) => { if (folder(id) && meeting(meetingId)) { store.addToFolder(id, meetingId); d.changed() } })
  ipcMain.handle('folders:remove', (_e, id: unknown, meetingId: unknown) => { if (isId(id) && isId(meetingId)) { store.removeFromFolder(id, meetingId); d.changed() } })
}
