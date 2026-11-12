import { describe, expect, it } from 'vitest'
import { emptyTrash, moveToTrash, purgeTrash } from '../src/main/trash'
import { TRASH_DAYS, trashCutoff } from '../src/shared/trash'

const DAY = 24 * 60 * 60 * 1000

describe('emptying the Trash', () => {
  it('deletes every meeting in it for good, one at a time, and counts the ones that could not go', async () => {
    const asked: string[] = []
    const r = await emptyTrash({
      store: { trashed: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      remove: async (id) => { asked.push(id); return id === 'b' ? 'failed' : 'deleted' },
    })
    expect(asked).toEqual(['a', 'b', 'c'])
    expect(r).toEqual({ deleted: 2, failed: 1 })
  })
  it('a meeting already gone counts as deleted', async () => {
    expect(await emptyTrash({ store: { trashed: () => [{ id: 'a' }] }, remove: async () => 'missing' })).toEqual({ deleted: 1, failed: 0 })
  })
})

describe('the Trash empties itself', () => {
  it(`after ${TRASH_DAYS} days in it, a meeting is deleted for good`, async () => {
    const now = 100 * DAY
    const asked: number[] = []
    const removed: string[] = []
    await purgeTrash({
      store: { trashedBefore: (at) => { asked.push(at); return ['old'] } },
      remove: async (id) => { removed.push(id); return 'deleted' },
    }, now)
    expect(asked).toEqual([trashCutoff(now)])
    expect(trashCutoff(now)).toBe(now - 30 * DAY)
    expect(removed).toEqual(['old'])
  })
  it('a failure is left for next time, never thrown', async () => {
    await expect(purgeTrash({ store: { trashedBefore: () => ['x'] }, remove: async () => { throw new Error('busy') } }, 0)).resolves.toBeUndefined()
  })
})

describe('moving a meeting to the Trash', () => {
  const rig = (state: 'done' | 'recording' = 'done') => {
    const log: string[] = []
    const meetings = new Map([['a', { id: 'a', state }]])
    const d = {
      store: { meeting: (id: string) => meetings.get(id), trashMeeting: (id: string) => { log.push(`trash ${id}`); return state !== 'recording' } },
      moved: (id: string) => { log.push(`moved ${id}`) },
    }
    return { log, d }
  }
  it('moves it and tells the windows', () => {
    const { log, d } = rig()
    expect(moveToTrash('a', d)).toBe('trashed')
    expect(log).toEqual(['trash a', 'moved a'])
  })
  it('never while it records, and nothing for an id that is not a meeting', () => {
    const { log, d } = rig('recording')
    expect(moveToTrash('a', d)).toBe('recording')
    expect(moveToTrash('zz', d)).toBe('missing')
    expect(moveToTrash('../x', d)).toBe('missing')
    expect(log).toEqual([])
  })
})
