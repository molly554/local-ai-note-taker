import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Meeting } from './store'

/**
 * The words a meeting's transcript is likely to get wrong: the names of the people in it and of their companies
 * (from their email addresses), which speech to text can mishear as a similar word.
 * Whisper gets them as its prompt, and the notes and answers are told how they are spelled.
 */
export type MeetingWords = { title: string; names: string[]; companies: string[]; /** the person's own list from Settings, spelled as they typed it */ jargon?: string[] }

/** mail providers: their address says nothing about anyone's company */
const PROVIDERS = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'icloud', 'me', 'mac', 'aol', 'proton', 'protonmail', 'pm', 'gmx', 'yandex', 'mail', 'fastmail', 'hey', 'zoho', 'qq', '163', '126', 'comcast', 'att', 'verizon'])

/** The company in a work address (person@company.example: Company); null for mail providers and names too short to be sure of */
export function companyOf(email: string): string | null {
  const host = email.split('@')[1]?.toLowerCase().trim()
  const labels = host?.split('.').filter(Boolean) ?? []
  if (labels.length < 2) return null
  const tld = labels.pop()!
  // co.uk, com.au: the second-level part is not the name
  if (tld.length === 2 && labels.length > 1 && labels.at(-1)!.length <= 3) labels.pop()
  const name = labels.at(-1)!
  const parts = name.split('-')
  if (PROVIDERS.has(name) || parts.some((p) => !/^[a-z][a-z0-9]+$/.test(p)) || name.length < 3) return null
  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('-')
}

/** the person using Yogurt: their name, and their own addresses as the calendar shows them on invites */
let ownerName = () => ''
const ownEmails = new Set<string>()
export const setOwnerName = (f: () => string): void => { ownerName = f }
export function noteOwnEmail(email: string | null | undefined): void { if (email?.includes('@')) ownEmails.add(email.toLowerCase()) }
/** the person's jargon (Settings → Language), read each time so a change counts from the next line on */
let jargonOf = (): string[] => []
export const setJargon = (f: () => string[]): void => { jargonOf = f }
/** for tests */
export const forgetOwnEmails = (): void => ownEmails.clear()

const unique = (xs: string[]) => {
  const seen = new Set<string>()
  return xs.map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
}

/** A title from the calendar or the person is kept; one made from the transcript may have the misheard word in it */
export function meetingWords(m: Pick<Meeting, 'title' | 'titleSource' | 'attendees'>): MeetingWords {
  const names = unique([...m.attendees.map((a) => a.name).filter((n) => !n.includes('@')), ownerName()])
  const emails = [...m.attendees.map((a) => a.email ?? (a.name.includes('@') ? a.name : '')), ...ownEmails]
  const companies = unique(emails.filter(Boolean).map((e) => companyOf(e) ?? ''))
  const title = m.titleSource === 'calendar' || m.titleSource === 'user' ? m.title.trim() : ''
  const jargon = unique(jargonOf())
  return { title, names, companies, ...(jargon.length ? { jargon } : {}) }
}

const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** whisper reads at most about 220 tokens of prompt */
const PROMPT_CHARS = 500

/**
 * Sentences give the speech model context that a bare word list does not. Empty when there is nothing to say.
 */
export function whisperPrompt(w: MeetingWords): string {
  let title = w.title.slice(0, 150).replace(/[.\s]+$/, '')
  let names = w.names.slice(0, 12)
  let companies = w.companies.slice(0, 4)
  // the person's own words are the surest: said once already in the people, not again; trimmed last
  const said = new Set([...names, ...companies].map((x) => x.toLowerCase()))
  let jargon = (w.jargon ?? []).filter((x) => !said.has(x.toLowerCase()))
  const build = () => {
    const who = names.length ? `With ${and(names)}${companies.length ? ` of ${and(companies)}` : ''}.` : companies.length ? `At ${and(companies)}.` : ''
    return [title && `${title}.`, who, jargon.length ? `We talk about ${and(jargon)}.` : ''].filter(Boolean).join(' ')
  }
  while (build().length > PROMPT_CHARS && names.length) names = names.slice(0, -1)
  while (build().length > PROMPT_CHARS && companies.length) companies = companies.slice(0, -1)
  if (build().length > PROMPT_CHARS) title = ''
  while (build().length > PROMPT_CHARS && jargon.length) jargon = jargon.slice(0, -1)
  return build()
}

/** a rule for the notes and answers; empty when there is nothing to spell */
export function spellingLine(w: MeetingWords): string {
  const words = unique([...(w.jargon ?? []), ...w.companies, ...w.names])
  return words.length ? `- Spelling: the transcript was typed by speech to text, which mishears names. These are spelled right: ${words.join(', ')}. Wherever the transcript has a word that sounds like one of them, write it as spelled here.` : ''
}

/** edits between two words, a swap of neighbours counting as one */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[a.length][b.length]
}

/**
 * Where the word list is: the Mac's own; on Windows and Linux the same list (Webster's 2nd, public domain, fetched by
 * scripts/native.mjs into resources/dict) next to the app, then a Linux computer's own
 */
export function dictionaryFiles(platform: string, resourcesPath: string | undefined): string[] {
  if (platform === 'darwin') return ['/usr/share/dict/words']
  return [
    ...(resourcesPath ? [join(resourcesPath, 'dict', 'words')] : []),
    join(__dirname, '../../resources/dict/words'),
    ...(platform === 'linux' ? ['/usr/share/dict/words'] : []),
  ]
}
let dictionary: Set<string> | undefined
/** the word list; without one every name counts as a word, so lowercase words are never changed */
function isWord(w: string): boolean {
  if (!dictionary) {
    dictionary = new Set()
    for (const f of dictionaryFiles(process.platform, process.resourcesPath)) {
      try { dictionary = new Set(readFileSync(f, 'utf8').toLowerCase().split(/\r?\n/)); break } catch { /* the next one */ }
    }
  }
  return !dictionary.size || dictionary.has(w.toLowerCase())
}

/** shorter words are too often an everyday word one letter off a name */
const MIN_RESPELL = 5

/**
 * Speech to text can substitute a familiar word for an unfamiliar name:
 * a word one letter off a company or name of the meeting takes its spelling. Capitalised words only, except for a
 * company that is no everyday word, so ordinary phrases are not changed into names.
 */
export function respell(text: string, w: MeetingWords): string {
  const jargon = w.jargon ?? []
  // a term of one word is like a company; the words of a longer one like a person's names
  const terms = jargon.filter((x) => !/\s/.test(x) && x.length >= MIN_RESPELL)
  const people = unique([...w.names, ...jargon.filter((x) => /\s/.test(x))].flatMap((n) => n.split(/\s+/))).filter((x) => x.length >= MIN_RESPELL)
  const companies = unique([...terms, ...w.companies]).filter((x) => x.length >= MIN_RESPELL)
  if (!people.length && !companies.length) return text
  const lowerOk = new Set(companies.filter((c) => !isWord(c)).map((c) => c.toLowerCase()))
  const targets = [...companies, ...people]
  return text.replace(/\p{L}+/gu, (tok) => {
    if (tok.length < MIN_RESPELL - 1) return tok
    const low = tok.toLowerCase()
    const capital = tok[0] !== low[0]
    let best: string | undefined
    for (const t of targets) {
      const tl = t.toLowerCase()
      if (!capital && !lowerOk.has(tl)) continue
      if (tl === low) return keepCapital(t, capital)
      if (!best && Math.abs(tl.length - low.length) <= 1 && distance(low, tl) === 1) best = t
    }
    return best ? keepCapital(best, capital) : tok
  })
}

/** a term the person typed all in lowercase keeps the capital a sentence gave it */
const keepCapital = (t: string, capital: boolean) => (capital && t === t.toLowerCase() ? t[0].toUpperCase() + t.slice(1) : t)
