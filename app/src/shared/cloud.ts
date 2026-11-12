/**
 * A model somewhere else for the writing (notes, titles, answers), reached the way OpenAI's chat API is, which most
 * services speak. Off unless the person turned it on in Settings and filled in all three. The transcript and what the
 * person typed go to that service then; recordings never do.
 */
export type Cloud = { /** the API's address up to and without /chat/completions, e.g. https://api.example.com/v1 */ url: string; model: string; key: string }

/** what Settings shows and saves: never the key itself, only whether one is kept */
export type CloudView = { on: boolean; url: string; model: string; hasKey: boolean }
export type CloudPatch = { on?: boolean; url?: string; model?: string; /** '' forgets the key */ key?: string }

/** an address a request can be sent to: http or https, with a host */
export const cloudAddress = (url: string | undefined): string | null => {
  try { const u = new URL((url ?? '').trim()); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.replace(/\/+$/, '') : null } catch { return null }
}
