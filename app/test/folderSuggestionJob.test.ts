import { afterEach, expect, it, vi } from 'vitest'
import { openStore } from '../src/main/store'
import { createQueue } from '../src/main/notes/queue'
import { createFolderSuggestions } from '../src/main/folderSuggestions'

const stores: ReturnType<typeof openStore>[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()) })
function setup() {
  const store = openStore(':memory:'); stores.push(store)
  const m = store.createMeeting({ title: 'Kickoff', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  store.setNotes(m.id, { enhanced: '## Launch\nWe agreed to ship on Monday.' })
  const f = store.createFolder('Customers')
  const chat = vi.fn(async () => JSON.stringify({ folder: f.name, confidence: 0.9 }))
  const queue = createQueue({ recording: () => false, smallMac: false })
  const jobs = createFolderSuggestions({ store, queue, model: { llm: async () => ({ contextSize: 8192, count: async () => [100], chat }) }, changed: vi.fn() })
  const settled = () => vi.waitFor(() => expect(queue.busy()).toBe(false))
  return { store, m, f, chat, jobs, settled }
}
it('persists a proposal once, accepts through normal filing and never repeats after removing membership', async () => {
  const { store, m, f, chat, jobs, settled } = setup()
  jobs.schedule(m.id); jobs.schedule(m.id); await settled()
  expect(store.folderSuggestion(m.id)).toMatchObject({ state: 'pending', folderId: f.id, confidence: 0.9 })
  expect(store.foldersOf(m.id)).toEqual([])
  jobs.refresh(); await settled(); expect(chat).toHaveBeenCalledTimes(1)
  store.addToFolder(f.id, m.id)
  expect(store.folderSuggestion(m.id).state).toBe('accepted')
  store.removeFromFolder(f.id, m.id); store.createFolder('Other'); jobs.refresh(); await settled()
  expect(chat).toHaveBeenCalledTimes(1)
})
it('dismissal is final, and a stale result cannot overwrite it', async () => {
  const { store, m, f, jobs, settled, chat } = setup()
  jobs.schedule(m.id); await settled(); store.dismissFolderSuggestion(m.id)
  store.saveFolderSuggestion(m.id, { folderId: f.id, confidence: 1 }, 'new')
  store.renameFolder(f.id, 'Clients'); jobs.refresh(); await settled()
  expect(store.folderSuggestion(m.id).state).toBe('dismissed'); expect(chat).toHaveBeenCalledTimes(1)
})
it('none is not retried on reopen, but a changed folder set permits one new attempt', async () => {
  const { store, m, f, chat, jobs, settled } = setup()
  chat.mockResolvedValue('{"folder":null,"confidence":0.1}')
  jobs.schedule(m.id); await settled(); jobs.refresh(); await settled()
  expect(chat).toHaveBeenCalledTimes(1)
  store.renameFolder(f.id, 'Clients'); jobs.refresh(); await settled()
  expect(chat).toHaveBeenCalledTimes(2)
})
it('does not save a result if the person files or trashes the meeting during inference', async () => {
  for (const action of ['file', 'trash']) {
    const { store, m, f, chat, jobs, settled } = setup()
    chat.mockImplementation(async () => {
      if (action === 'file') store.addToFolder(f.id, m.id); else store.trashMeeting(m.id)
      return JSON.stringify({ folder: f.name, confidence: 1 })
    })
    jobs.schedule(m.id); await settled()
    expect(store.folderSuggestion(m.id).state).toBeNull()
  }
})
it('separate folder jobs wait during recording and yield to questions and read-ahead', async () => {
  let recording = true
  const queue = createQueue({ recording: () => recording, smallMac: false })
  const log: string[] = []
  const a = queue.enqueue(async () => { log.push('folder-a') }, 'folder', 'a')
  const b = queue.enqueue(async () => { log.push('folder-b') }, 'folder', 'b')
  expect(log).toEqual([])
  const c = queue.enqueue(async () => { log.push('chat') }, 'chat')
  const r = queue.enqueue(async () => { log.push('read') }, 'readahead')
  recording = false; queue.recordingChanged()
  await Promise.all([a, b, c, r])
  expect(log).toEqual(['chat', 'read', 'folder-a', 'folder-b'])
})
it('interrupts a running suggestion for recording, then retries after recording ends', async () => {
  let recording = false, tries = 0
  const queue = createQueue({ recording: () => recording, smallMac: false })
  const done = queue.enqueue(signal => {
    tries++
    return tries === 1 ? new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())) : Promise.resolve()
  }, 'folder', 'a')
  recording = true; queue.recordingChanged()
  await Promise.resolve(); await Promise.resolve()
  expect(tries).toBe(1)
  recording = false; queue.recordingChanged(); await done
  expect(tries).toBe(2)
})
