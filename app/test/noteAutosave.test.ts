import { describe, expect, it, vi } from 'vitest'
import { NoteAutosave, registerAutosave } from '../src/renderer/src/noteAutosave'
import type { NoteSaveResult } from '../src/shared/types'

describe('note autosave acknowledgement', () => {
  it('an older acknowledgement cannot clear newer typing; flush waits for the latest revision', async () => {
    const replies: Array<(r: NoteSaveResult) => void> = []
    const save = vi.fn(() => new Promise<NoteSaveResult>((r) => replies.push(r)))
    const a = new NoteAutosave(save, () => ({ revision: 0, status: 'failed' }))
    a.change('first')
    const pending = a.flush()
    a.change('second, exact latest text')
    replies[0]({ revision: 1, status: 'saved' })
    await Promise.resolve(); await Promise.resolve()
    expect(a.status).toBe('saving')
    expect(save).toHaveBeenLastCalledWith({ text: 'second, exact latest text', revision: 2 })
    replies[1]({ revision: 2, status: 'saved' })
    expect(await pending).toBe(true)
    expect(a.status).toBe('saved')
    a.dispose()
  })
  it('retains failed text for retry and seeds a recreated editor from main', async () => {
    const save = vi.fn().mockResolvedValueOnce({ revision: 8, status: 'failed' }).mockResolvedValueOnce({ revision: 8, status: 'saved' })
    const a = new NoteAutosave(save, () => ({ revision: 8, status: 'failed' }))
    a.seed('unsaved exact text', { revision: 8, status: 'failed' })
    expect(await a.flush()).toBe(false)
    expect(a.status).toBe('failed')
    expect(await a.flush()).toBe(true)
    a.seed('unsaved exact text', { revision: 8, status: 'failed' }) // a delayed render of the old server view
    expect(a.status).toBe('saved')
    expect(save.mock.calls).toEqual([[{ text: 'unsaved exact text', revision: 8 }], [{ text: 'unsaved exact text', revision: 8 }]])
    a.dispose()
  })
  it('hands the final debounced revision to main before unload; an older async failure cannot undo it', async () => {
    let reply!: (r: NoteSaveResult) => void
    const handoff = vi.fn((e: { revision: number }) => ({ revision: e.revision, status: 'saved' as const }))
    const a = new NoteAutosave(() => new Promise<NoteSaveResult>((r) => { reply = r }), handoff)
    a.change('older')
    const pending = a.flush()
    a.change('last keystroke')
    expect(a.flushSync()).toBe(true)
    expect(handoff).toHaveBeenCalledWith({ text: 'last keystroke', revision: 2 })
    reply({ revision: 1, status: 'failed' })
    expect(await pending).toBe(true)
    expect(a.status).toBe('saved')
    a.dispose()
  })
  it('hands a newer revision to main before navigation unregisters an editor with an older write in flight', async () => {
    let reply!: (r: NoteSaveResult) => void
    const handoff = vi.fn((e: { revision: number }) => ({ revision: e.revision, status: 'saved' as const }))
    const a = new NoteAutosave(() => new Promise<NoteSaveResult>((r) => { reply = r }), handoff)
    const unmount = registerAutosave(a)
    a.change('first'); const pending = a.flush()
    a.change('latest before navigation')
    unmount()
    expect(handoff).toHaveBeenCalledWith({ text: 'latest before navigation', revision: 2 })
    reply({ revision: 1, status: 'saved' })
    expect(await pending).toBe(true)
  })
  it('allows unload only when the exact draft was saved or retained, including an oversized draft', () => {
    const handoff = vi.fn().mockReturnValueOnce({ revision: 1, status: 'failed', retained: false })
      .mockReturnValue({ revision: 1, status: 'failed', retained: true, reason: 'too-long' })
    const a = new NoteAutosave(async () => ({ revision: 1, status: 'failed' }), handoff)
    a.change('full oversized draft')
    expect(a.flushSync()).toBe(false)
    expect(a.flushSync()).toBe(true)
    expect(a.status).toBe('failed')
    expect(a.reason).toBe('too-long')
    a.dispose()
  })
  it('keeps a synchronous transport failure retryable', async () => {
    const a = new NoteAutosave(() => { throw new Error('transport unavailable') }, () => { throw new Error('transport unavailable') })
    a.change('still here')
    expect(await a.flush()).toBe(false)
    expect(a.status).toBe('failed')
    expect(a.flushSync()).toBe(false)
    a.dispose()
  })
})
