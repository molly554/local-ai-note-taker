import { describe, expect, it } from 'vitest'
import { parseFilters } from '../src/main/library/filters'
import { questionKind } from '../src/main/library/kind'

// Wednesday 5 November 2026, 15:30 local time
const now = new Date(2026, 10, 4, 15, 30).getTime()
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime()
const names = ['Tarun Shah', 'Ann Lee', 'Ann Smith', 'Will Ford', 'Bo Park']
const f = (q: string) => parseFilters(q, { now, names })

describe('dates in a question', () => {
  it('today, yesterday, this week, last week, this month, last month', () => {
    expect(f('what did we say today?')).toMatchObject({ from: day(2026, 10, 4), to: day(2026, 10, 5) })
    expect(f('Yesterday')).toMatchObject({ from: day(2026, 10, 3), to: day(2026, 10, 4) })
    // weeks start on Monday
    expect(f('my to-dos this week')).toMatchObject({ from: day(2026, 10, 2), to: day(2026, 10, 9) })
    expect(f('what happened last week')).toMatchObject({ from: day(2026, 9, 26), to: day(2026, 10, 2) })
    expect(f('decisions this month')).toMatchObject({ from: day(2026, 10, 1), to: day(2026, 11, 1) })
    expect(f('decisions last month')).toMatchObject({ from: day(2026, 9, 1), to: day(2026, 10, 1) })
  })
  it('a month by name: this year, or last year when it has not come yet; a day of it', () => {
    expect(f('what did Bo say in October?')).toMatchObject({ from: day(2026, 9, 1), to: day(2026, 10, 1) })
    expect(f('the plan from december')).toMatchObject({ from: day(2025, 11, 1), to: day(2026, 0, 1) })
    expect(f('notes from October 12')).toMatchObject({ from: day(2026, 9, 12), to: day(2026, 9, 13) })
    // "may" as a word is not a month
    expect(f('may I see the budget?').from).toBeUndefined()
  })
  it('a weekday: the latest one, today included; "last" leaves today out', () => {
    expect(f('on Monday')).toMatchObject({ from: day(2026, 10, 2), to: day(2026, 10, 3) })
    expect(f("Wednesday's standup")).toMatchObject({ from: day(2026, 10, 4), to: day(2026, 10, 5) })
    expect(f('last wednesday')).toMatchObject({ from: day(2026, 9, 28), to: day(2026, 9, 29) })
  })
  it('the last few days', () => {
    expect(f('in the past 3 days')).toMatchObject({ from: now - 3 * 86_400_000, to: now })
    expect(f('over the last 10 days')).toMatchObject({ from: now - 10 * 86_400_000, to: now })
  })
  it('takes the date words out of what is searched for', () => {
    expect(f('what did we decide about pricing last week?').rest).toBe('what did we decide about pricing?')
    expect(f('pricing').from).toBeUndefined()
  })
})

describe('people in a question', () => {
  it('by full name or first name, any case, with or without an s', () => {
    expect(f('what did Tarun Shah say about pricing?').people).toEqual(['Tarun Shah'])
    expect(f("tarun's take on pricing").people).toEqual(['Tarun Shah'])
    expect(f('what did Ann think?').people).toEqual(['Ann Lee', 'Ann Smith'])
    expect(f('meetings with Bo and Tarun').people).toEqual(['Bo Park', 'Tarun Shah'])
  })
  it('a first name that is an everyday word counts only when written with a capital', () => {
    expect(f('will we ship on time?').people).toEqual([])
    expect(f('what did Will say?').people).toEqual(['Will Ford'])
  })
})

describe('the kind of question', () => {
  const k = (q: string) => questionKind(q, f(q))
  it('finding what was said is "find"', () => {
    expect(k('what did Tarun say about pricing?')).toBe('find')
    expect(k('when is the launch?')).toBe('find')
    expect(k('who mentioned the contractor')).toBe('find')
  })
  it('gathering across meetings is "across"', () => {
    expect(k('my to-dos this week')).toBe('across')
    expect(k('all my action items this month')).toBe('across')
    expect(k('what did we decide last week?')).toBe('across')
    expect(k('Summarize my meetings from yesterday')).toBe('across')
    expect(k('what are my next steps?')).toBe('across')
    expect(k('recap of this week')).toBe('across')
  })
})
