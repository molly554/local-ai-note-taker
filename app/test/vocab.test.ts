import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { companyOf, forgetOwnEmails, meetingWords, noteOwnEmail, dictionaryFiles, respell, setJargon, setOwnerName, spellingLine, whisperPrompt } from '../src/main/vocab'
import { enhancePrompt } from '../src/main/notes/enhance'
import { contextTail } from '../src/main/chat'
import { parseEvents } from '../src/main/calendar'

const noDictionary = !existsSync('/usr/share/dict/words')

afterEach(() => { setOwnerName(() => ''); setJargon(() => []); forgetOwnEmails() })

const robin = { title: 'Northwind Integration and Zentrik Data with Robin', titleSource: 'calendar' as const, attendees: [{ name: 'Robin Smith', email: 'robin@northwind.com' }, { name: 'Tarun Mehra', email: 'tarun@gmail.com' }] }

describe('companyOf', () => {
  it('names the company from a work address', () => {
    expect(companyOf('alex@zentrik.example')).toBe('Zentrik')
    expect(companyOf('ana@mail.acme.co.uk')).toBe('Acme')
    expect(companyOf('bo@north-wind.io')).toBe('North-Wind')
  })
  it('says nothing for mail providers or names too short to be sure of', () => {
    for (const e of ['sam@gmail.com', 'sam@icloud.com', 'sam@outlook.com', 'tarun@gmail.com', 'no-at-sign', 'x@localhost']) expect(companyOf(e)).toBeNull()
  })
})

describe('meetingWords', () => {
  it('has the names, the companies of everyone on the invite (the person using Yogurt too) and a title that came from them', () => {
    setOwnerName(() => 'Alex Morgan')
    noteOwnEmail('alex@zentrik.example')
    expect(meetingWords(robin)).toEqual({ title: robin.title, names: ['Robin Smith', 'Tarun Mehra', 'Alex Morgan'], companies: ['Northwind', 'Zentrik'] })
  })
  it('leaves out a title made from the transcript (it may have the misheard word) or a generic one, and emails standing in for names', () => {
    const w = meetingWords({ title: 'Zentric onboarding', titleSource: 'auto', attendees: [{ name: 'jo@zentrik.example', email: 'jo@zentrik.example' }] })
    expect(w).toEqual({ title: '', names: [], companies: ['Zentrik'] })
    expect(meetingWords({ title: 'Zoom call', titleSource: 'generic', attendees: [] }).title).toBe('')
  })
  it('lists each word once, whatever its case', () => {
    expect(meetingWords({ title: '', titleSource: 'user', attendees: [{ name: 'Ann Lee', email: 'a@zentrik.example' }, { name: 'ann lee', email: 'b@Zentrik.example' }] })).toEqual({ title: '', names: ['Ann Lee'], companies: ['Zentrik'] })
  })
})

describe('whisperPrompt', () => {
  // the shape that got every "Zentrik" and "Tarun" right on test clips, where a bare list of words changed nothing
  it('is the title, then who is in it and where from, as sentences', () => {
    expect(whisperPrompt({ title: robin.title, names: ['Robin Smith', 'Tarun Mehra', 'Alex Morgan'], companies: ['Zentrik'] }))
      .toBe('Northwind Integration and Zentrik Data with Robin. With Robin Smith, Tarun Mehra and Alex Morgan of Zentrik.')
    expect(whisperPrompt({ title: '', names: [], companies: ['Zentrik', 'Northwind'] })).toBe('At Zentrik and Northwind.')
    expect(whisperPrompt({ title: '', names: [], companies: [] })).toBe('')
  })
  it('stays short, well inside what whisper reads of a prompt', () => {
    const names = Array.from({ length: 80 }, (_, i) => `Person Number${i}`)
    expect(whisperPrompt({ title: 'A'.repeat(300), names, companies: ['Zentrik'] }).length).toBeLessThanOrEqual(500)
  })
})

describe('the spelling line', () => {
  const words = { title: robin.title, names: ['Robin Smith'], companies: ['Zentrik'] }
  it('tells the notes how to spell what the transcript may have misheard, after the transcript', () => {
    const p = enhancePrompt({ title: robin.title, attendees: robin.attendees, mine: '', transcript: 'Them: we use zentric', language: 'English', spelling: spellingLine(words) })
    expect(p).toContain('Zentrik, Robin Smith')
    expect(spellingLine(words)).not.toMatch(/Zentric|Kentrik/)
    expect(p.indexOf('Zentrik, Robin Smith')).toBeGreaterThan(p.indexOf('</transcript>'))
  })
  it('is left out when there is nothing to spell', () => {
    expect(spellingLine({ title: 'x', names: [], companies: [] })).toBe('')
  })
  it('reaches answers about the meeting too', () => {
    expect(contextTail({ title: robin.title, attendees: robin.attendees }, { mine: '', enhanced: null, edited: false }, spellingLine(words))).toContain('Zentrik, Robin Smith')
  })
})

describe('the calendar', () => {
  it("keeps the address of the person using this Mac from an event's invite", () => {
    parseEvents([{ id: 'e', title: 'x', start: '2026-11-02T16:00:00Z', end: '2026-11-02T16:30:00Z', me: 'alex@zentrik.example', attendees: [] }])
    expect(meetingWords({ title: '', titleSource: 'user', attendees: [] }).companies).toEqual(['Zentrik'])
  })
})

describe('respell', () => {
  const w = { title: '', names: ['Tarun Mehra', 'Grant Hill', 'Jo Li'], companies: ['Zentrik', 'Northwind'] }
  // lowercase words are respelled only against the computer's word list (the Mac has one; the CI's Windows and Linux don't)
  it.skipIf(noDictionary)("fixes a company or name speech to text heard one letter off, whatever its case, keeping what follows", () => {
    expect(respell("The Zentric checklist and zentric data, Kentrik's SDK and Zantrik.", w)).toBe("The Zentrik checklist and Zentrik data, Zentrik's SDK and Zentrik.")
    expect(respell('Taran said the North wind sync and northwin are fine.', w)).toBe('Tarun said the North wind sync and Northwind are fine.')
  })
  it('leaves everyday words alone: a lowercase word is never taken for a name, and short words are never touched', () => {
    expect(respell('a grand plan, hills and a job for Joe', w)).toBe('a grand plan, hills and a job for Joe')
    expect(respell('Mehar said so.', w)).toBe('Mehra said so.')
    // a company that is an everyday word too: only a capitalised word is taken for it
    expect(respell('the motion passed, Notion and Motion', { title: '', names: [], companies: ['Notion'] })).toBe('the motion passed, Notion and Notion')
  })
  it('changes nothing with no words to go by', () => {
    expect(respell('Zentric', { title: 'x', names: [], companies: [] })).toBe('Zentric')
  })
})

describe('personal jargon', () => {
  const none = { title: '', names: [], companies: [] }
  it('joins every meeting\'s words, as the person spelled it, once', () => {
    setJargon(() => ['PostHog', ' SOC 2 ', 'posthog', ''])
    expect(meetingWords({ title: '', titleSource: 'user', attendees: [] }).jargon).toEqual(['PostHog', 'SOC 2'])
  })
  it('is left out of a meeting\'s words when there is none', () => {
    expect(meetingWords({ title: '', titleSource: 'user', attendees: [] })).not.toHaveProperty('jargon')
  })
  it('goes to whisper as a sentence of its own, after the people, without repeating them', () => {
    expect(whisperPrompt({ title: 'Launch', names: ['Ann Lee'], companies: ['Zentrik'], jargon: ['PostHog', 'zentrik', 'SOC 2'] }))
      .toBe('Launch. With Ann Lee of Zentrik. We talk about PostHog and SOC 2.')
    expect(whisperPrompt({ ...none, jargon: ['Kubernetes'] })).toBe('We talk about Kubernetes.')
  })
  it('is kept in whisper\'s prompt before names and titles when there is too much to say', () => {
    const names = Array.from({ length: 80 }, (_, i) => `Person Number${i}`)
    const p = whisperPrompt({ title: 'A'.repeat(300), names, companies: ['Zentrik'], jargon: ['PostHog', 'Kubernetes', 'SOC 2'] })
    expect(p.length).toBeLessThanOrEqual(500)
    expect(p).toContain('We talk about PostHog, Kubernetes and SOC 2.')
    const long = Array.from({ length: 100 }, (_, i) => `Term${i}`)
    expect(whisperPrompt({ ...none, jargon: long }).length).toBeLessThanOrEqual(500)
  })
  it('is in the spelling line for the notes and answers, the person\'s spelling first', () => {
    const line = spellingLine({ title: '', names: ['Ann Lee'], companies: ['Zentrik'], jargon: ['zentrik', 'PostHog'] })
    expect(line).toContain('zentrik, PostHog, Ann Lee.')
    expect(line).not.toContain('Zentrik,')
    expect(spellingLine({ ...none, jargon: ['SOC 2'] })).toContain('SOC 2')
  })
  it.skipIf(noDictionary)('respells a word one letter off with the person\'s spelling and casing', () => {
    const w = { ...none, jargon: ['Kubernetes', 'PostHog', 'Acme Rocketry'] }
    expect(respell('We moved Kubernetis to posthog. The Rocketri team agreed, and kubernetis too.', w))
      .toBe('We moved Kubernetes to PostHog. The Rocketry team agreed, and Kubernetes too.')
  })
  it.skipIf(noDictionary)('keeps a capital the sentence gave a term typed in lowercase', () => {
    expect(respell('Zentric said so, and the zentric SDK too.', { ...none, jargon: ['zentrik'] })).toBe('Zentrik said so, and the zentrik SDK too.')
  })
  it('leaves everyday words alone, as for names and companies', () => {
    const w = { ...none, jargon: ['Stripe', 'API'] }
    expect(respell('a stripe of paint and a strip of tape, the APO', w)).toBe('a stripe of paint and a strip of tape, the APO')
    expect(respell('Strip is where we pay.', w)).toBe('Stripe is where we pay.')
  })
})

describe('the word list for lowercase respelling', () => {
  it("a Mac reads its own; Windows and Linux read the same list shipped with Yogurt (Webster's 2nd, public domain)", () => {
    expect(dictionaryFiles('darwin', '/R')).toEqual(['/usr/share/dict/words'])
    expect(dictionaryFiles('win32', 'C:\\Y\\resources')[0]).toMatch(/resources[\\/]dict[\\/]words$/)
    expect(dictionaryFiles('linux', '/opt/y/resources')).toEqual([expect.stringMatching(/[\\/]opt[\\/]y[\\/]resources[\\/]dict[\\/]words$/), expect.stringMatching(/resources[\\/]dict[\\/]words$/), '/usr/share/dict/words'])
  })
})
