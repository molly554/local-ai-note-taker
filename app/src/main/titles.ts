/**
 * Where a meeting's title came from. Only a generic one (what Yogurt names a meeting with no event) or one Yogurt wrote
 * from the notes may be replaced by a title from the notes; one they typed or one from the calendar never is.
 */
export type TitleSource = 'generic' | 'calendar' | 'user' | 'auto' | 'imported'

/** what Yogurt (or an older copy of it) names a meeting that has no event title */
const ENGLISH = /^(?:.{1,40} call|meeting|untitled|new note|google meet|(?:zoom|teams|microsoft teams|webex|slack) meeting)$/i

/**
 * The interface language's own generic words, given by the app once its language is set (index.ts). Passed in rather
 * than read from i18n here, so the store and the notes code load anywhere (tests, scripts) without the locale tables.
 */
type Generic = { meeting: string; /** "{app} call" with the app's place marked by \u0000 */ appCall: string }
let local: Generic = { meeting: 'Meeting', appCall: '\u0000 call' }
export const setGenericTitles = (g: Generic) => { local = g }

/** a title that says nothing about the meeting: "Zoom call", "Meeting", "Untitled", in English or the interface's language */
export function genericTitle(title: string): boolean {
  const s = title.replace(/\s+/g, ' ').trim()
  if (!s) return true
  if (ENGLISH.test(s) || s === local.meeting) return true
  // "{app} call" as the interface's language words it, whatever the app
  const [before, after = ''] = local.appCall.split('\u0000')
  return s.length > before.length + after.length && s.startsWith(before) && s.endsWith(after) && s.length - before.length - after.length <= 40
}

/** the source a title has when nothing else says: generic, the calendar's (with an event), or theirs */
export const sourceOf = (title: string, eventId: string | null): TitleSource => (genericTitle(title) ? 'generic' : eventId ? 'calendar' : 'user')
