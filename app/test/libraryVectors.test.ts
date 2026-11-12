import { describe, expect, it } from 'vitest'
import { docText, fuse, queryText, toVector, VectorIndex } from '../src/main/library/vectors'

describe('vectors', () => {
  it('keeps the first dims and makes them unit length (EmbeddingGemma: the first dims are a smaller embedding of their own)', () => {
    const v = toVector([3, 4, 100, 100], 2)
    expect([...v]).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)])
  })
  it('asks the model in its own prompt forms for a question and for a piece of a meeting', () => {
    expect(queryText('when is the launch?')).toBe('task: search result | query: when is the launch?')
    expect(docText('Weekly sync', 'Bo: Tuesday')).toBe('title: Weekly sync | text: Bo: Tuesday')
    expect(docText('', 'x')).toBe('title: none | text: x')
  })
  it('finds the closest chunks, within the meetings asked for', () => {
    const idx = new VectorIndex()
    idx.set('a', [{ id: 1, vector: toVector([1, 0, 0], 3) }, { id: 2, vector: toVector([0.7, 0.7, 0], 3) }])
    idx.set('b', [{ id: 3, vector: toVector([0, 1, 0], 3) }])
    const q = toVector([1, 0.1, 0], 3)
    expect(idx.top(q, 10)).toEqual([1, 2, 3])
    expect(idx.top(q, 1)).toEqual([1])
    expect(idx.top(q, 10, new Set(['b']))).toEqual([3])
    idx.drop('a')
    expect(idx.top(q, 10)).toEqual([3])
    expect(idx.has('a')).toBe(false)
  })
  it('a thousand hours of meetings are searched in well under 50 ms', () => {
    const idx = new VectorIndex()
    const dims = 512, perMeeting = 30
    for (let m = 0; m < 1000; m++) idx.set(`m${m}`, Array.from({ length: perMeeting }, (_, i) => ({ id: m * perMeeting + i, vector: toVector(Array.from({ length: dims }, () => Math.random() - 0.5), dims) })))
    const q = toVector(Array.from({ length: dims }, () => Math.random() - 0.5), dims)
    idx.top(q, 50)
    const t0 = performance.now()
    idx.top(q, 50)
    expect(performance.now() - t0).toBeLessThan(50)
  })
  it('fuses rankings by reciprocal rank: found by both beats found high by one', () => {
    expect(fuse([[1, 2, 3], [3, 4, 1]])).toEqual([1, 3, 2, 4])
    expect(fuse([[], [5]])).toEqual([5])
  })
})
