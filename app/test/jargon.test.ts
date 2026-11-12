import { describe, expect, it } from 'vitest'
import { addTerm, cleanJargon, MAX_TERM, MAX_TERMS } from '../src/shared/jargon'

describe('personal jargon list', () => {
  it('adds a term trimmed, with inner spaces made single', () => {
    expect(addTerm(['PostHog'], '  SOC   2 ')).toEqual(['PostHog', 'SOC 2'])
  })
  it('never adds a blank or one already there, whatever its case', () => {
    expect(addTerm(['PostHog'], '   ')).toEqual(['PostHog'])
    expect(addTerm(['PostHog'], 'posthog')).toEqual(['PostHog'])
  })
  it('keeps terms short and the list a sensible length', () => {
    expect(addTerm([], 'x'.repeat(200))[0]).toHaveLength(MAX_TERM)
    const full = Array.from({ length: MAX_TERMS }, (_, i) => `t${i}`)
    expect(addTerm(full, 'one more')).toEqual(full)
  })
  it('cleans what was saved: only strings, trimmed, once each, at most the limit', () => {
    expect(cleanJargon(['a', ' A ', 3, null, 'b ', ''])).toEqual(['a', 'b'])
    expect(cleanJargon('nope')).toEqual([])
    expect(cleanJargon(Array.from({ length: MAX_TERMS + 5 }, (_, i) => `t${i}`))).toHaveLength(MAX_TERMS)
  })
})
