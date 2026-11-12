/**
 * What this app is called. It is a fork of Yogurt (FrigadeHQ/yogurt, MIT): the interface texts and their 31
 * translations still say "Yogurt", as upstream wrote them, and the name is put in as each text is shown
 * (named(), below), so the tables stay easy to bring up to date from upstream.
 */
export const PRODUCT = 'Lynote NoteTaker'

// Two languages attach an ending to the name that depends on its last sounds: Hungarian "Yogurtot" (a linking vowel
// the new name does not take), Turkish "Yogurt’u" (vowel harmony, and d for t after the new name's r).
const ENDINGS: Record<string, Array<[RegExp, string]>> = {
  hu: [[/Yogurtot/g, `${PRODUCT}t`]],
  tr: [[/Yogurt[’']un/g, `${PRODUCT}’ın`], [/Yogurt[’']u/g, `${PRODUCT}’ı`], [/Yogurt[’']tan/g, `${PRODUCT}’dan`]],
}

/** a text of upstream's with this app's name in place of "Yogurt" */
export function named(text: string, lang = 'en'): string {
  if (!text.includes('Yogurt')) return text
  for (const [from, to] of ENDINGS[lang] ?? []) text = text.replace(from, to)
  return text.replaceAll('Yogurt', PRODUCT)
}
