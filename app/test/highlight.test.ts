import { describe, expect, it } from 'vitest'
import { markWords } from '../src/shared/highlight'

describe('markWords', () => {
  it('marks each word of the query, any case, the last as a beginning', () => {
    expect(markWords('Budget review', 'budg')).toEqual([{ text: 'Budg', hit: true }, { text: 'et review', hit: false }])
    expect(markWords('Weekly budget sync', 'sync BUDGET')).toEqual([
      { text: 'Weekly ', hit: false }, { text: 'budget', hit: true }, { text: ' ', hit: false }, { text: 'sync', hit: true },
    ])
  })
  it('leaves text alone when nothing matches, and never treats the query as a pattern', () => {
    expect(markWords('a.b (c)', '(.*)')).toEqual([{ text: 'a.b (c)', hit: false }])
    expect(markWords('Plan', '')).toEqual([{ text: 'Plan', hit: false }])
  })
  it('marks Chinese inside a run', () => {
    expect(markWords('下周预算会', '预算')).toEqual([{ text: '下周', hit: false }, { text: '预算', hit: true }, { text: '会', hit: false }])
  })
})
