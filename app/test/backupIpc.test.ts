import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { exportBackup, importBackup } from '../src/main/backup'
import { hookBackup } from '../src/main/backupIpc'

const handlers = new Map<string, () => Promise<unknown>>()
vi.mock('electron', () => ({
  app: { getPath: () => '/docs', getVersion: () => '1.0.0' },
  ipcMain: { handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler), on: () => {} },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/docs/backup.zip' })),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/docs/backup.zip'] })),
  },
  shell: { showItemInFolder: vi.fn() },
}))
vi.mock('../src/main/backup', () => ({
  exportBackup: vi.fn(async () => ({ meetings: 2 })),
  importBackup: vi.fn(async () => ({ ok: true, added: 2, skipped: 0 })),
}))
const changed = vi.fn()
const beforeExport = vi.fn<() => string | undefined>(() => undefined)
let recording = false
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear(); recording = false
  hookBackup({ db: {} as never, meetingsDir: '/meetings', window: () => undefined, recording: () => recording, changed, beforeExport })
})
const call = (channel: string) => handlers.get(channel)!()

describe('backup IPC results', () => {
  it('refuses a stale snapshot while a retained note is unsaved, before opening or replacing any file', async () => {
    beforeExport.mockReturnValueOnce('note-with-unsaved-text')
    expect(await call('backup:export')).toEqual({ ok: false, error: 'unsaved', meetingId: 'note-with-unsaved-text' })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(exportBackup).not.toHaveBeenCalled()
  })
  it('checks retained text again after the save dialog returns', async () => {
    beforeExport.mockReturnValueOnce(undefined).mockReturnValueOnce('new-unsaved-text')
    expect(await call('backup:export')).toEqual({ ok: false, error: 'unsaved', meetingId: 'new-unsaved-text' })
    expect(exportBackup).not.toHaveBeenCalled()
  })
  it('returns normal export and import results, and refreshes the meeting list after import', async () => {
    expect(await call('backup:export')).toEqual({ ok: true, meetings: 2 })
    expect(await call('backup:import')).toEqual({ ok: true, added: 2, skipped: 0 })
    expect(changed).toHaveBeenCalledOnce()
  })
  it('turns dialog rejection into a visible failure result', async () => {
    vi.mocked(dialog.showSaveDialog).mockRejectedValueOnce(new Error('dialog failed'))
    vi.mocked(dialog.showOpenDialog).mockRejectedValueOnce(new Error('dialog failed'))
    expect(await call('backup:export')).toEqual({ ok: false, error: 'failed' })
    expect(await call('backup:import')).toEqual({ ok: false, error: 'failed' })
    expect(exportBackup).not.toHaveBeenCalled()
    expect(importBackup).not.toHaveBeenCalled()
  })
  it('returns failure for an unexpected import rejection without notifying success', async () => {
    vi.mocked(importBackup).mockRejectedValueOnce(new Error('cannot prepare import'))
    expect(await call('backup:import')).toEqual({ ok: false, error: 'failed' })
    expect(changed).not.toHaveBeenCalled()
  })
  it('preserves a committed import result if notifying a closed window fails', async () => {
    changed.mockImplementationOnce(() => { throw new Error('window closed') })
    expect(await call('backup:import')).toEqual({ ok: true, added: 2, skipped: 0 })
  })
  it('checks again for recording after the file dialog closes', async () => {
    vi.mocked(dialog.showOpenDialog).mockImplementationOnce(async () => {
      recording = true
      return { canceled: false, filePaths: ['/docs/backup.zip'] }
    })
    expect(await call('backup:import')).toEqual({ ok: false, error: 'recording' })
    expect(importBackup).not.toHaveBeenCalled()
  })
})
