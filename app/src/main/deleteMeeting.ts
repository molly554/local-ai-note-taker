import { rm } from 'node:fs/promises'
import { isId } from './ipcArgs'
import type { Store } from './store'

export type DeleteResult = 'deleted' | 'recording' | 'missing' | 'failed'

/**
 * Deleting a meeting for good: never while it records. Its model jobs (notes, names, chat, reading ahead) are dropped
 * first, then the recorder and transcript are let finish so nothing writes into its folder after. Remove its audio
 * folder before its rows: a file-removal failure leaves the meeting available to retry.
 */
export async function deleteMeeting(id: unknown, d: {
  store: Pick<Store, 'meeting' | 'deleteMeeting'>
  dirOf: (id: string) => string
  /** drop its jobs in the model queue and any chat answer */
  cancel: (id: string) => void
  /** resolves only when its recording and transcript are final, never just because a wait timed out */
  settle: (id: string) => Promise<void>
  /** it is gone: the windows reload and a note showing it closes */
  removed: (id: string) => void
}): Promise<DeleteResult> {
  if (!isId(id)) return 'missing'
  const m = d.store.meeting(id)
  if (!m) return 'missing'
  if (m.state === 'recording') return 'recording'
  try {
    d.cancel(id)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        d.settle(id),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('meeting files are still being written')), 30_000) }),
      ])
    } finally { clearTimeout(timer) }
    await rm(d.dirOf(id), { recursive: true, force: true })
    d.store.deleteMeeting(id)
  } catch (e) {
    console.error('deleting the meeting failed', id, e)
    return 'failed'
  }
  try { d.removed(id) } catch (e) { console.warn('meeting deleted; window refresh failed', id, e) }
  return 'deleted'
}
