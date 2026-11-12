import { describe, expect, it } from 'vitest'
import { parsePerson, peopleSummary, peopleChipSummary, personName } from '../src/renderer/src/components/People'

describe('people on a note', () => {
  it('reads a name, a name and email, or an email alone', () => {
    expect(parsePerson('  Maya   Chen ')).toEqual({ name: 'Maya Chen', email: null })
    expect(parsePerson('Maya Chen <maya@x.com>')).toEqual({ name: 'Maya Chen', email: 'maya@x.com' })
    expect(parsePerson('Maya Chen maya@x.com')).toEqual({ name: 'Maya Chen', email: 'maya@x.com' })
    expect(parsePerson('maya@x.com')).toEqual({ name: 'maya@x.com', email: 'maya@x.com' })
    expect(parsePerson('   ')).toBeNull()
  })
  it('keeps email identity but uses a name in the visible record and compact label', () => {
    expect(personName('Maya Chen <maya@example.com>')).toBe('Maya Chen')
    expect(personName('maya.chen@example.com')).toBe('Maya chen')
    expect(personName('...@example.com')).toBe('...')
    expect(parsePerson('maya.chen@example.com')?.email).toBe('maya.chen@example.com')
    expect(peopleSummary([{ name: 'maya.chen@example.com', email: 'maya.chen@example.com' }], 'Sam Rivera')).toBe('Maya')
  })
  it('caps compact labels at three first names, never counting the person themself', () => {
    const p = (name: string) => ({ name, email: null })
    expect(peopleSummary([], 'Sam Rivera')).toBe('Me')
    expect(peopleSummary([p('sam rivera')], 'Sam Rivera')).toBe('Me')
    expect(peopleSummary([p('Ann Lee')], 'Sam Rivera')).toBe('Ann')
    expect(peopleSummary([p('Ann Lee'), p('Bo Park')], 'Sam Rivera')).toBe('Ann, Bo')
    expect(peopleSummary([p('Ann Lee'), p('Bo Park'), p('Cy Ho')], 'Sam Rivera')).toBe('Ann, Bo, Cy')
    expect(peopleSummary([p('Ann Lee'), p('Sam Rivera'), p('Bo Park'), p('Cy Ho'), p('Di Wu')], 'Sam Rivera')).toBe('Ann, Bo, Cy + 1')
    expect(peopleSummary(['Sam Rivera', 'Ann Lee', 'Bo Park', 'Cy Ho', 'Di Wu', 'Eli Grey', 'Finn Day', 'Gia Ray', 'Hal Kim'].map(p), 'Sam Rivera')).toBe('Ann, Bo, Cy + 5')
    expect(peopleSummary(Array.from({ length: 40 }, (_, i) => p(`Guest${i + 1} Family`)), 'Sam Rivera')).toBe('Guest1, Guest2, Guest3 + 37')
  })
})

it('the people chip uses two first names, excludes me and invites adding to an empty list', () => {
  const p = (name: string) => ({ name, email: null })
  expect(peopleChipSummary([], 'Sam Rivera')).toBe('Add attendees')
  expect(peopleChipSummary([p(' sam rivera ')], 'Sam Rivera')).toBe('Add attendees')
  expect(peopleChipSummary([p('Jamie Quill')], 'Sam Rivera')).toBe('Jamie')
  expect(peopleChipSummary(['Jamie Quill', 'Sam Rivera', 'Bo Park'].map(p), 'Sam Rivera')).toBe('Jamie, Bo')
  expect(peopleChipSummary(['Jamie Quill', 'Bo Park', 'Ann Lee'].map(p), 'Sam Rivera')).toBe('Jamie, Bo + 1')
})
