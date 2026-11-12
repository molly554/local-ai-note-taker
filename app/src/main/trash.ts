import type { DeleteResult } from './deleteMeeting'
import { isId } from './ipcArgs'
import type { Store } from './store'
import { trashCutoff } from '../shared/trash'

export type TrashResult = 'trashed' | 'recording' | 'missing'

/** Delete from a list or a note: to the Trash, where it can be restored (Undo, or the Trash page). Never while it records. */
export function moveToTrash(id: unknown, d: { store: { meeting: (id: string) => { state: string } | undefined; trashMeeting: (id: string) => boolean }; moved: (id: string) => void }): TrashResult {
  if (!isId(id)) return 'missing'
  const m = d.store.meeting(id)
  if (!m) return 'missing'
  if (m.state === 'recording') return 'recording'
  // already in the Trash is fine: it is where it was asked to go
  d.store.trashMeeting(id)
  d.moved(id)
  return 'trashed'
}

/** deletes one meeting for good (deleteMeeting with its hooks) */
type Remove = (id: string) => Promise<DeleteResult | 'save-pending'>

/** Empty Trash: every meeting in it deleted for good, one at a time (each waits for its own files) */
export async function emptyTrash(d: { store: { trashed: () => Array<{ id: string }> }; remove: Remove }): Promise<{ deleted: number; failed: number }> {
  let deleted = 0, failed = 0
  for (const { id } of d.store.trashed()) {
    const r = await d.remove(id).catch(() => 'failed' as const)
    if (r === 'deleted' || r === 'missing') deleted++
    else failed++
  }
  return { deleted, failed }
}

/** Meetings in the Trash longer than TRASH_DAYS go for good. Anything that can't go now is tried again next time. */
export async function purgeTrash(d: { store: Pick<Store, 'trashedBefore'>; remove: Remove }, now = Date.now()): Promise<void> {
  for (const id of d.store.trashedBefore(trashCutoff(now))) {
    try { await d.remove(id) } catch (e) { console.warn('emptying the Trash by itself failed', id, e) }
  }
}
