import { createHash } from 'node:crypto'
import { folderSuggestionPrompt, parseFolderSuggestion, shouldSuggestFolder } from '../shared/folderSuggestion'
import type { Store } from './store'
import type { Queue } from './notes/queue'
import type { NotesModel } from './notes/model'

/** Never files anything: this background job only saves a proposal for the note's confirmation pill. */
export function createFolderSuggestions(o: { store: Store; queue: Queue; model: Pick<NotesModel, 'llm'>; changed: () => void }) {
  const { store } = o
  const queued = new Set<string>()
  // Appearance and sidebar order do not change a folder's meaning.
  const fingerprint = () => createHash('sha256').update(JSON.stringify(store.folders().map(f => [f.id, f.name]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex')
  const eligible = (id: string, stamp: string) => {
    const m = store.meeting(id), previous = store.folderSuggestion(id)
    return !!m && shouldSuggestFolder({ hasFolders: store.folders().length > 0, filed: store.foldersOf(id).length > 0,
      trashed: m.trashedAt != null, recording: m.state === 'recording', summary: !!store.notes(id).enhanced,
      state: previous.state, attempted: previous.attempted, fingerprint: stamp })
  }
  function schedule(id: string) {
    if (queued.has(id) || !eligible(id, fingerprint())) return
    const requested = fingerprint()
    queued.add(id)
    void o.queue.enqueue(async signal => {
      const stamp = fingerprint()
      if (!eligible(id, stamp)) return
      const m = store.meeting(id)!
      const folders = store.folders().map(f => ({ id: f.id, name: f.name, examples: store.folderMeetingIds(f.id).slice(0, 4).map(id => store.meeting(id)!.title) }))
      const llm = await o.model.llm(signal)
      const prompt = folderSuggestionPrompt(folders, { ...m, summary: store.notes(id).enhanced! })
      // Do not quietly drop folders when an unusually large library exceeds the model's context.
      if ((await llm.count([prompt]))[0] + 128 > llm.contextSize) {
        if (!signal.aborted) store.saveFolderSuggestion(id, { folderId: null, confidence: null }, stamp)
        return
      }
      const answer = await llm.chat(prompt, () => {}, { maxTokens: 128, temperature: 0 })
      if (signal.aborted || fingerprint() !== stamp) return
      const result = parseFolderSuggestion(answer, folders)
      store.saveFolderSuggestion(id, eligible(id, stamp) ? result : { ...result, folderId: null }, stamp)
      o.changed()
    }, 'folder', id).catch(e => console.error('suggesting a folder failed', id, e)).finally(() => { queued.delete(id); if (fingerprint() !== requested) schedule(id) })
  }
  function refresh() {
    const rows = store.db.prepare("SELECT m.id FROM meetings m JOIN notes n ON n.meeting_id = m.id WHERE m.trashed_at IS NULL AND m.suggestion_state IS NULL AND n.enhanced IS NOT NULL").all()
    for (const row of rows) schedule(String(row.id))
  }
  return { schedule, refresh }
}
