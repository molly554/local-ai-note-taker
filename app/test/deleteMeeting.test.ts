import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { deleteMeeting } from '../src/main/deleteMeeting'
import { isId } from '../src/main/ipcArgs'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-delete-'))
  dirs.push(root)
  const store = openStore(join(root, 'yogurt.db'))
  stores.push(store)
  const meetings = join(root, 'meetings')
  const make = (state: 'recording' | 'stopped' | 'done') => {
    const m = store.createMeeting({ title: 'Sync', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state })
    mkdirSync(join(meetings, m.id), { recursive: true })
    writeFileSync(join(meetings, m.id, 'me.m4a'), 'audio')
    return m
  }
  const log: string[] = []
  const deps = {
    store, dirOf: (id: string) => join(meetings, id),
    cancel: (id: string) => { log.push(`cancel ${id}`) },
    settle: async (id: string) => { log.push(`settle ${id}`) },
    removed: (id: string) => { log.push(`removed ${id}`) },
  }
  return { store, meetings, make, log, deps, root }
}

describe('deleting a meeting', () => {
  it('stops its jobs, waits for its files, then removes its rows and its folder (audio too), and tells the windows', async () => {
    const s = setup()
    const m = s.make('done')
    s.store.setNotes(m.id, { mine: 'hi' })
    expect(await deleteMeeting(m.id, s.deps)).toBe('deleted')
    expect(s.store.meeting(m.id)).toBeUndefined()
    expect(existsSync(join(s.meetings, m.id))).toBe(false)
    expect(s.log).toEqual([`cancel ${m.id}`, `settle ${m.id}`, `removed ${m.id}`])
  })
  it('refuses while it records, and keeps everything', async () => {
    const s = setup()
    const m = s.make('recording')
    expect(await deleteMeeting(m.id, s.deps)).toBe('recording')
    expect(s.store.meeting(m.id)).toBeDefined()
    expect(existsSync(join(s.meetings, m.id, 'me.m4a'))).toBe(true)
    expect(s.log).toEqual([])
  })
  it('still reports deleted when notifying the windows fails after removal', async () => {
    const s = setup(), m = s.make('done')
    s.deps.removed = () => { throw new Error('window closed') }
    expect(await deleteMeeting(m.id, s.deps)).toBe('deleted')
    expect(s.store.meeting(m.id)).toBeUndefined()
    expect(existsSync(join(s.meetings, m.id))).toBe(false)
  })
  it('keeps a retryable meeting when its audio folder cannot be removed', async () => {
    const s = setup(), m = s.make('done')
    s.store.setNotes(m.id, { mine: 'keep these until deletion completes' })
    vi.mocked(rm).mockRejectedValueOnce(new Error('EACCES'))
    expect(await deleteMeeting(m.id, s.deps)).toBe('failed')
    expect(s.store.meeting(m.id)).toBeDefined()
    expect(s.store.notes(m.id).mine).toBe('keep these until deletion completes')
    expect(existsSync(join(s.meetings, m.id, 'me.m4a'))).toBe(true)
    expect(s.log).toEqual([`cancel ${m.id}`, `settle ${m.id}`])
    expect(await deleteMeeting(m.id, s.deps)).toBe('deleted')
    expect(s.store.meeting(m.id)).toBeUndefined()
    expect(existsSync(join(s.meetings, m.id))).toBe(false)
  })
  it('does not claim deletion when rows fail after audio removal, and can retry', async () => {
    const s = setup(), m = s.make('done')
    vi.spyOn(s.store, 'deleteMeeting').mockImplementationOnce(() => { throw new Error('database busy') })
    expect(await deleteMeeting(m.id, s.deps)).toBe('failed')
    expect(s.store.meeting(m.id)).toBeDefined()
    expect(existsSync(join(s.meetings, m.id))).toBe(false)
    expect(s.log).toEqual([`cancel ${m.id}`, `settle ${m.id}`])
    expect(await deleteMeeting(m.id, s.deps)).toBe('deleted')
    expect(s.store.meeting(m.id)).toBeUndefined()
  })
  it('keeps the files and rows when writers have not settled', async () => {
    const s = setup(), m = s.make('done')
    s.deps.settle = async () => { throw new Error('recorder still writing') }
    expect(await deleteMeeting(m.id, s.deps)).toBe('failed')
    expect(s.store.meeting(m.id)).toBeDefined()
    expect(existsSync(join(s.meetings, m.id, 'me.m4a'))).toBe(true)
    expect(s.log).toEqual([`cancel ${m.id}`])
  })
  it('times out without deleting while a writer remains active, then permits retry once it finishes', async () => {
    vi.useFakeTimers()
    const s = setup(), m = s.make('done')
    let finish!: () => void
    const writing = new Promise<void>((resolve) => { finish = resolve })
    s.deps.settle = () => writing
    let result: string | undefined
    const pending = deleteMeeting(m.id, s.deps).then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(30_000)
    const atDeadline = result
    const keptAtDeadline = !!s.store.meeting(m.id) && existsSync(join(s.meetings, m.id, 'me.m4a'))
    finish()
    await pending
    expect(atDeadline).toBe('failed')
    expect(keptAtDeadline).toBe(true)
    expect(s.store.meeting(m.id)).toBeDefined()
    expect(existsSync(join(s.meetings, m.id, 'me.m4a'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(await deleteMeeting(m.id, s.deps)).toBe('deleted')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('an unknown or odd id deletes nothing, never a folder outside the meetings', async () => {
    const s = setup()
    writeFileSync(join(s.root, 'keep.txt'), 'x')
    for (const bad of ['nope', '..', '../keep.txt', '', 42, null]) expect(await deleteMeeting(bad, s.deps)).toBe('missing')
    expect(existsSync(join(s.root, 'keep.txt'))).toBe(true)
    expect(s.log).toEqual([])
  })
})

describe('isId', () => {
  it('a meeting id: letters, digits and dashes only', () => {
    expect(isId('5b8a6f8e-1c2d-4e3f-9a0b-1234567890ab')).toBe(true)
    for (const bad of ['', '..', 'a/b', 'a b', 'x'.repeat(65), 1, null, undefined, {}]) expect(isId(bad)).toBe(false)
  })
})
