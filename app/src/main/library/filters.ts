/**
 * Dates and people read out of a question in plain code, no model: they narrow which meetings are searched before
 * anything else. English words only for now; a question in another language is searched whole.
 * from/to: a range of meeting start times (local days, weeks starting on Monday). people: full names it mentions.
 * rest: the question without its date words, for the word search.
 */
export type Filters = { from?: number; to?: number; people: string[]; rest: string }

const DAY = 86_400_000
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const SHORT = MONTHS.map((m) => m.slice(0, 3))
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
/** first names that are also everyday words: a person only when written with a capital */
const EVERYDAY = new Set(['will', 'may', 'mark', 'bill', 'june', 'april', 'august', 'art', 'grace', 'hope', 'joy', 'rose', 'max', 'sky', 'dawn', 'faith', 'frank', 'pat', 'sue', 'ray', 'rob', 'jack', 'chase', 'drew', 'gene', 'guy', 'lane', 'skip', 'sunny', 'summer', 'river', 'page', 'wade', 'win'])

const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
/** a local day moved by n days (daylight saving keeps it at midnight) */
const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime() }
const monday = (t: number) => addDays(midnight(t), -((new Date(t).getDay() + 6) % 7))
const monthStart = (y: number, m: number) => new Date(y, m, 1).getTime()
const monthOf = (w: string) => { const i = MONTHS.indexOf(w); return i >= 0 ? i : SHORT.indexOf(w) }

type Rule = { re: RegExp; range: (m: RegExpMatchArray, now: number) => [number, number] | undefined }
const RULES: Rule[] = [
  { re: /\b(?:in |over |during )?the (?:past|last) (\d{1,3}) days\b/i, range: (m, now) => [now - Number(m[1]) * DAY, now] },
  { re: /\btoday\b|\bthis (?:morning|afternoon|evening)\b/i, range: (_m, now) => [midnight(now), addDays(now, 1)] },
  { re: /\byesterday\b/i, range: (_m, now) => [addDays(now, -1), midnight(now)] },
  { re: /\b(this|last|past) week\b/i, range: (m, now) => {
    const start = monday(now)
    return m[1].toLowerCase() === 'this' ? [start, addDays(start, 7)] : [addDays(start, -7), start]
  } },
  { re: /\b(this|last|past) month\b/i, range: (m, now) => {
    const d = new Date(now), y = d.getFullYear(), mo = d.getMonth()
    return m[1].toLowerCase() === 'this' ? [monthStart(y, mo), monthStart(y, mo + 1)] : [monthStart(y, mo - 1), monthStart(y, mo)]
  } },
  // a month: after in/during/from/of/since/last, or with a day number ("October 12"); never "may" on its own
  { re: new RegExp(`\\b(?:(?:in|during|from|of|since|last) )?(${[...MONTHS, ...SHORT.filter((s) => s !== 'may')].join('|')})\\b(?: (\\d{1,2})(?:st|nd|rd|th)?\\b)?`, 'i'), range: (m, now) => {
    const word = m[1].toLowerCase(), named = /^(in|during|from|of|since|last) /i.test(m[0])
    // "may" and short names ("oct", "jan") alone are too often something else
    if (!named && !m[2] && (word === 'may' || SHORT.includes(word))) return undefined
    const mo = monthOf(word), d = new Date(now)
    // a month still to come this year means last year's
    const y = mo > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear()
    if (m[2]) { const day = new Date(y, mo, Number(m[2])).getTime(); return [day, addDays(day, 1)] }
    return [monthStart(y, mo), monthStart(y, mo + 1)]
  } },
  { re: new RegExp(`\\b(?:(on|last) )?(${WEEKDAYS.join('|')})(?:'s)?\\b`, 'i'), range: (m, now) => {
    const want = WEEKDAYS.indexOf(m[2].toLowerCase())
    let back = (new Date(now).getDay() - want + 7) % 7
    if (back === 0 && m[1]?.toLowerCase() === 'last') back = 7
    const day = addDays(now, -back)
    return [day, addDays(day, 1)]
  } },
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** names: everyone known from the meetings (invited, or seen speaking), as full names */
export function parseFilters(question: string, o: { now: number; names: string[] }): Filters {
  let rest = question
  let range: [number, number] | undefined
  for (const r of RULES) {
    const m = rest.match(r.re)
    if (!m) continue
    const found = r.range(m, o.now)
    if (!found) continue
    range ??= found
    rest = rest.replace(m[0], ' ')
  }
  rest = rest.replace(/\s+([?.!,])/g, '$1').replace(/\s+/g, ' ').trim()

  const people: string[] = []
  for (const name of [...new Set(o.names.map((n) => n.trim()).filter(Boolean))]) {
    const first = name.split(/\s+/)[0]
    const whole = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'iu')
    // a two-letter first name (Bo, Al) or an everyday word (Will) only with its capital
    const exact = EVERYDAY.has(first.toLowerCase()) || first.length < 3
    const firstRe = new RegExp(`(?<![\\p{L}\\p{N}])${escape(first)}(?![\\p{L}\\p{N}])`, exact ? 'u' : 'iu')
    if (whole.test(question) || (first.length >= 2 && firstRe.test(question))) people.push(name)
  }
  // in the order the question names them
  const at = (n: string) => { const i = question.toLowerCase().indexOf(n.split(/\s+/)[0].toLowerCase()); return i < 0 ? Infinity : i }
  people.sort((a, b) => at(a) - at(b))
  return { ...(range ? { from: range[0], to: range[1] } : {}), people, rest }
}
