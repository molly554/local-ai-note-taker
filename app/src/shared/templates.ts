/**
 * What kind of meeting a Summary is laid out for. 'general' is how every Summary was written before there were
 * templates: its prompt is the same as it was. Each of the others adds a few lines to that prompt
 * (main/notes/enhance.ts): what such a meeting's notes need that a general meeting's don't.
 */
export const TEMPLATES = ['general', 'team', 'one-on-one', 'customer', 'interview'] as const
export type Template = (typeof TEMPLATES)[number]
export const isTemplate = (v: unknown): v is Template => TEMPLATES.includes(v as Template)

/**
 * How notes are written, beyond their language: the template, whether what people will do comes first, and what
 * the person asked for in their own words (Settings → Summary).
 */
export type NotesStyle = { template: Template; nextStepsFirst: boolean; extra: string }
export const PLAIN_STYLE: NotesStyle = { template: 'general', nextStepsFirst: false, extra: '' }
/** what Settings sends to change it: only what changed */
export type NotesStylePatch = Partial<NotesStyle>

/** the person's own request: one line, this long at most (it goes into every notes prompt) */
export const EXTRA_CHARS = 400
export const cleanExtra = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, EXTRA_CHARS) : '')
