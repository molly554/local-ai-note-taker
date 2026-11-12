import type { NoteSaveResult } from '../../shared/types'

const SAVE_AFTER_MS = 1000
type Edit = { text: string; revision: number }

/** One side of one note. Only an acknowledgement of its exact revision clears a dirty edit. */
export class NoteAutosave {
  private revision = 0
  private pending: Edit | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<boolean> | undefined
  status: 'saved' | 'saving' | 'failed' = 'saved'
  reason: 'too-long' | undefined
  changed = () => {}

  constructor(private save: (edit: Edit) => Promise<NoteSaveResult>, private handoff: (edit: Edit) => NoteSaveResult) {}

  /** A reopened note receives main's retained failed text and last revision. No renderer side effect. */
  seed(text: string, saved?: NoteSaveResult) {
    if (!saved || saved.revision < this.revision) return
    if (this.flight && saved.revision === this.revision) return
    if (saved.revision === this.revision && this.status === 'saved' && saved.status === 'failed') return
    this.revision = saved.revision
    if (saved.status === 'failed') { this.pending = { text, revision: saved.revision }; this.status = 'failed'; this.reason = saved.reason }
    else if (!this.pending || this.pending.revision === saved.revision) { this.pending = undefined; this.status = 'saved'; this.reason = undefined }
  }

  change(text: string) {
    this.pending = { text, revision: ++this.revision }
    this.status = 'saving'; this.reason = undefined; this.changed()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, SAVE_AFTER_MS)
  }

  private acknowledge(edit: Edit, result: NoteSaveResult) {
    if (this.pending?.revision !== edit.revision) return
    if (result.revision === edit.revision && result.status === 'saved') { this.pending = undefined; this.status = 'saved' }
    else this.status = 'failed'
    this.reason = result.reason
    this.changed()
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.flight) return this.flight
    const edit = this.pending
    if (!edit) return Promise.resolve(true)
    this.status = 'saving'; this.changed()
    let request: Promise<NoteSaveResult>
    try { request = this.save(edit) } catch { request = Promise.resolve({ revision: edit.revision, status: 'failed' }) }
    this.flight = request.catch((): NoteSaveResult => ({ revision: edit.revision, status: 'failed' })).then((result) => {
      this.acknowledge(edit, result)
      this.flight = undefined
      // Typing continued during the write: save that newer revision before reporting flush complete.
      if (this.pending && this.pending.revision > edit.revision) return this.flush()
      return !this.pending
    })
    return this.flight
  }

  /** Renderer destruction cannot wait for a promise. Main retains this final text even if its write fails. */
  flushSync(): boolean {
    clearTimeout(this.timer)
    const edit = this.pending
    if (!edit) return true
    try {
      const result = this.handoff(edit)
      this.acknowledge(edit, result)
      return result.status === 'saved' || result.retained === true
    }
    catch { this.status = 'failed'; this.changed(); return false }
  }

  dispose(): boolean { clearTimeout(this.timer); this.changed = () => {}; return this.flushSync() }
}

/** Only mounted editors register here; failed drafts already handed off remain in the main process. */
const open = new Set<NoteAutosave>()
export const registerAutosave = (save: NoteAutosave) => { open.add(save); return () => { if (save.dispose()) open.delete(save) } }
export const flushOpenNotes = async (): Promise<boolean> => (await Promise.all([...open].map((s) => s.flush()))).every(Boolean)
export const handoffOpenNotes = (): boolean => [...open].map((s) => s.flushSync()).every(Boolean)
