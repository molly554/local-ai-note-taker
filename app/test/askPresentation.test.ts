import { expect, it, vi } from 'vitest'
import { askHomeConversation, recentHistory } from '../src/shared/askPresentation'

it('caps recent conversations after removing empty entries, preserving order and week boundaries', () => {
  const now = new Date(2026, 10, 6, 12).getTime()
  const day = (date: number) => new Date(2026, 10, date, 9).getTime()
  const list = [
    { id: 'blank', title: '', draft: '', updatedAt: now },
    { id: 'draft', title: '', draft: 'Unsent question', updatedAt: now },
    { id: 'today', title: 'Today', draft: '', updatedAt: day(6) },
    { id: 'monday', title: 'Monday', draft: '', updatedAt: day(2) },
    { id: 'sunday', title: 'Sunday', draft: '', updatedAt: day(1) },
  ]
  expect(recentHistory(list, 3, now)).toEqual({ groups: [[list[1], list[2]], [list[3]], []], hasMore: true })
  expect(recentHistory(list, Infinity, now)).toEqual({ groups: [[list[1], list[2]], [list[3]], [list[4]]], hasMore: false })
  expect(list).toHaveLength(5)
})

it('reuses an unsent home draft but gives a completed conversation a fresh home composer', async () => {
  const current = vi.fn().mockResolvedValueOnce('draft')
  const get = vi.fn().mockResolvedValue({ turns: [], draft: 'Keep me' })
  expect(await askHomeConversation({ current, get })).toBe('draft')
  expect(current.mock.calls).toEqual([[[]]])
  current.mockReset().mockResolvedValueOnce('old').mockResolvedValueOnce('new')
  get.mockResolvedValue({ turns: [{ question: 'Earlier question' }], draft: 'Keep this with the old conversation' })
  expect(await askHomeConversation({ current, get })).toBe('new')
  expect(current.mock.calls).toEqual([[[]], [[], true]])
})

it('propagates a failed home read instead of replacing a draft it could not read', async () => {
  const current = vi.fn().mockResolvedValue('draft')
  await expect(askHomeConversation({ current, get: vi.fn().mockRejectedValue(new Error('disk')) })).rejects.toThrow('disk')
  expect(current).toHaveBeenCalledOnce()
})
