/** Personal jargon: names, products and acronyms the person wants spelled right in every meeting (Settings → Language) */

/** long enough for a product name with a word or two after it */
export const MAX_TERM = 50
/** whisper reads only a few of them; the notes get all, so the list stays a size the notes can carry */
export const MAX_TERMS = 100

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TERM).trim()

/** the list with one more term, or the same list: blank, already there (whatever its case) or full */
export function addTerm(list: string[], term: string): string[] {
  const t = clean(term)
  if (!t || list.length >= MAX_TERMS || list.some((x) => x.toLowerCase() === t.toLowerCase())) return list
  return [...list, t]
}

/** what was saved or sent, made safe: strings only, each once, at most MAX_TERMS */
export function cleanJargon(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.reduce<string[]>((list, x) => (typeof x === 'string' ? addTerm(list, x) : list), [])
}
