import type { SnippetPart } from '../main/store'

/** text in pieces, hit where a word of the query appears (any case); plain string matching, never a pattern */
export function markWords(text: string, query: string): SnippetPart[] {
  const words = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const lower = text.toLocaleLowerCase()
  // lowercasing can change lengths in a few scripts: then nothing is marked rather than the wrong letters
  const hit = new Array<boolean>(text.length).fill(false)
  if (lower.length === text.length) {
    for (const w of words) for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + 1)) hit.fill(true, i, i + w.length)
  }
  const parts: SnippetPart[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1)
    if (last && last.hit === hit[i]) last.text += text[i]
    else parts.push({ text: text[i], hit: hit[i] })
  }
  return parts.length ? parts : [{ text, hit: false }]
}
