import type { Person, Segment } from '../store'
import { respell, spellingLine, type MeetingWords } from '../vocab'

/**
 * Enhanced notes: the person's own notes plus the transcript, written up by the notes model as Markdown.
 * Everything here is plain text in, plain text out; the model is reached through `Llm`, so tests use a stand-in.
 * Prompts are never translated: they go to the model.
 */

export type Llm = {
  /** tokens the loaded model can read at once */
  contextSize: number
  /** tokens in each text, by the loaded model's own tokenizer */
  count(texts: string[]): Promise<number[]>
  /**
   * one answer; onToken gets the text as it is written. summary: a part of a long meeting, not shown.
   * before: an earlier prompt and its answer, in that order, that this one follows on from
   */
  chat(prompt: string, onToken: (text: string) => void, o?: { summary?: boolean; maxTokens?: number; before?: string[]; /** colder sampling for an answer that must come out the same each time */ temperature?: number }): Promise<string>
  /** reads the start of a prompt into the model without answering, so a prompt that starts the same way later reads only the rest */
  readAhead?(text: string, signal?: AbortSignal): Promise<void>
}

/** A long meeting's part summarised while it was recorded: its transcript lines and the summary */
export type PartSummary = { lines: string[]; summary: string }

/** room left for the notes themselves */
export const NOTES_TOKENS = 2048
/** each part's summary of a long meeting */
export const SUMMARY_TOKENS = 700
/** a long meeting is read in parts of at most this: smaller parts keep more detail */
export const MAX_PART_TOKENS = 12_000

/** "es" → "Spanish". Empty when unknown, and the prompt then asks for the transcript's language */
export function languageName(code: string | null | undefined): string {
  if (!code || code === 'auto') return ''
  // whisper-server says "spanish"; codes like "es" or "pt-BR" are named by the system
  if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(code)) return code.charAt(0).toUpperCase() + code.slice(1)
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? '' } catch { return '' }
}

/** "You: …" for the mic, "<Name>: …" for the other side when the call app showed who talked, "Them: …" otherwise */
export function transcriptText(segments: Segment[]): string {
  const who = (s: Segment) => (s.track === 'me' ? 'You' : s.speaker || 'Them')
  const turns: Array<{ who: string; text: string }> = []
  for (const s of segments) {
    const w = who(s)
    const last = turns.at(-1)
    if (last && last.who === w) last.text += ` ${s.text}`
    else turns.push({ who: w, text: s.text })
  }
  return turns.map((t) => `${t.who}: ${t.text}`).join('\n')
}

type PromptInput = {
  title: string; attendees: Person[]; mine: string; transcript: string; language: string
  /** the person who recorded it, so the invite's other person is known */
  me?: string
  /** how long the meeting was */
  minutes?: number
  /** the transcript is part summaries */
  parts?: boolean
  /** how names and companies are spelled (vocab.ts spellingLine) */
  spelling?: string
  /** everyone was heard on the one mic (a meeting in a room): every line says "You" whoever spoke */
  oneMic?: boolean
}

/**
 * How every prompt that reads a whole transcript starts (the notes, and naming the voices), the transcript right
 * after it. The model reads this during the meeting (readAhead.ts), so after it only the rest is new: never change it
 * for one meeting, and put anything new after the transcript.
 */
export const transcriptHead = 'Here is the transcript of a meeting. Each line starts with who said it: "You" is the person who recorded it, a name is someone on the call, and "Them" is the other side of the call when no name is known. What to do with it comes after it.\n<transcript>\n'

/** the rule about people, for the notes and for answers about a meeting */
export const peopleRule = '- People: use their names when known, and "You" for the person these notes are for. "Them" is not a name: write who they are in plain words ("the client", "the other person"), or leave out who said it. Never make up a name.'

/** the one other person invited, when there is exactly one: "Them" is then that person */
function onlyOther(attendees: Person[], me = ''): string | undefined {
  const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
  const others = attendees.map((a) => a.name?.trim()).filter((n): n is string => !!n && (!me.trim() || fold(n) !== fold(me)))
  return others.length === 1 ? others[0] : undefined
}

/**
 * What stays the same comes first (the transcript, which only grows), then what can change after the meeting
 * (names, title, the person's notes), then how to write.
 */
export function enhancePrompt(i: PromptInput): string {
  const lang = i.language || 'the language most of the transcript is in'
  const people = i.attendees.map((a) => a.name).filter(Boolean)
  const other = onlyOther(i.attendees, i.me)
  const mine = i.mine.trim()
  const mins = i.minutes != null ? Math.max(1, Math.round(i.minutes)) : undefined
  return [
    ...(i.parts ? [
      'You will write the notes for a meeting that just ended. It was long, so here are notes on each part of it, in order, written from its transcript ("You" is the person these notes are for):',
      '<transcript>', i.transcript, '</transcript>',
    ] : [transcriptHead + i.transcript, '</transcript>']),
    '',
    'Write the notes for this meeting, which just ended, for "You" to read later: the work that was talked about, what was decided, and who will do what.',
    '',
    `Meeting: ${i.title || 'Untitled'}`,
    `People invited: ${people.length ? people.join(', ') : 'not known'}. "You" is the person these notes are for.${other ? ` "Them" is ${other}.` : ''}`,
    ...(i.oneMic ? ['Nothing came from a call: everyone in the room was heard on one microphone, so every line says "You" whoever spoke. If several people talked, credit something to "You" only when the line itself makes clear who said it, and otherwise leave out who said it.'] : []),
    ...(mins != null ? [`Length: about ${mins} minute${mins === 1 ? '' : 's'}.`] : []),
    '',
    ...(mine ? ['Notes they typed, before or during the meeting. They show what they care about and flagged, and facts they know that may not have been said. They are hints for writing the notes, not text to copy:', '<notes>', mine, '</notes>', ''] : []),
    'How to write them, so they read at a glance:',
    `- Write in ${lang}, headings too.`,
    peopleRule,
    ...(i.spelling ? [i.spelling] : []),
    '- Markdown only. Start right away with the first "## " topic: no title, no introduction, nothing after the last bullet.',
    '- Notes are about the work: customers, deals and prices, numbers, plans, problems, launches, what each person is working on, what was decided. Leave out what was off topic: small talk, greetings, weekends and trips, hobbies, side projects, jokes, gear, errands and other personal chat, and talk about the call itself. Something personal goes in only if the meeting was about it.',
    '- One "## " section per topic, most important first, each named after what it is about in a few specific words (like "Pricing for Acme renewal" or "Desktop app launch", never "Discussion", "Updates" or "Topic 1"). Bring together what was said about one topic at different times. When people took turns giving their own updates, a section per person, like "## Maya\'s updates", works well.',
    '- Under each topic, "- " bullets with real substance: what was said, found, proposed or decided, and why. Keep the concrete details: names of customers and companies, numbers, prices, dates, tools, and who said it when that matters. A bullet is one full point of up to about 20 words, starting with the point (never "The team discussed"). More detail goes in "  - " bullets under it.',
    '- A decision or an open question goes in its topic, said plainly ("Decided: no paid placements for now").',
    '- Cover the whole meeting, the end as well. A short meeting gets fewer sections, not thinner ones.',
    '- **Bold** rarely: a deadline, a big number or a key term, a few times in all.',
    ...(mine ? [
      '- Their notes steer these: what they flagged gets a "## " topic or a bullet of its own, and facts they typed that the transcript lacks go in, in the topic they belong to.',
      '- Write it all in your own words and in the shape below, blended into the topics: never copy their lines, labels (like "GOAL", "WHO" or "CLOSE"), headings or numbering, and never give their notes a section of their own.',
      '- Their notes can be a plan or a script made before the meeting: a question or step in it goes in only if the transcript shows it was asked or done, with what came of it.',
    ] : []),
    '- Use only what was said or typed. Never make anything up.',
    `- Last, "## Next steps" (in ${lang}) only if someone said they would do something after the meeting: one bullet each, as "- **Name:** what they will do, by when" (when only if it was said), "**You:**" for the person these notes are for, plain words for someone without a name, like "**The designer:**". Leave out jokes and personal errands. Otherwise leave the section out.`,
    '',
    'The shape, with made-up placeholders:',
    '## <topic>',
    '- <point>',
    '  - <detail>',
    '## <topic>',
    '- <point>',
    '## Next steps',
    '- **<Name>:** <task>, by <when>',
  ].join('\n')
}

/** How part n's summary prompt starts, its transcript right after: the same whatever comes later, so it can be read in early */
export const summaryHead = (n: number) => `Here is part ${n} of a long meeting's transcript. "You" is the person taking notes.\n<transcript>\n`

export function summaryPrompt(part: string, n: number, language: string): string {
  const lang = language || 'the language the transcript is in'
  return [
    summaryHead(n) + part, '</transcript>',
    '',
    `Write compact notes on this part only, in ${lang}: every topic discussed with its concrete details (numbers, dates, names, tools, examples), what was decided, open questions, and who agreed to do what (by name, "You" for the person taking notes).`,
    'Short "- " bullets grouped under a "### " line naming the topic. Nothing else: no introduction, no closing line.',
  ].join('\n')
}

/**
 * Cuts a transcript ("Name: words" a line) into pieces of at most maxTokens, only between turns.
 * A single turn longer than that is cut between sentences, each piece starting with who said it.
 */
export function splitForContext(transcript: string, maxTokens: number, count: (s: string) => number): string[] {
  if (count(transcript) <= maxTokens) return [transcript]
  const turns = transcript.split('\n').flatMap((t) => (count(t) <= maxTokens ? [t] : cutTurn(t, maxTokens, count)))
  const pieces: string[] = []
  let cur: string[] = [], size = 0
  for (const t of turns) {
    // +1 for the line break between turns
    const n = count(t) + 1
    if (cur.length && size + n > maxTokens) { pieces.push(cur.join('\n')); cur = []; size = 0 }
    cur.push(t); size += n
  }
  if (cur.length) pieces.push(cur.join('\n'))
  return pieces
}

/** Chinese, Japanese and Korean letters: a tokenizer gives each about a token of its own, where other writing gets about one per three characters */
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
/** a guess at the tokens in a text the model's tokenizer has not counted, on the high side so a part never outgrows its room */
export function roughTokens(s: string): number {
  const cjk = s.match(CJK_LETTER)?.length ?? 0
  return cjk + Math.ceil((s.length - cjk) / 3)
}

/**
 * A sentence too long for a part on its own: speech to text often leaves Chinese and Japanese without punctuation, so a
 * whole talk is one "sentence". It is cut between words, and a run with no spaces in it between characters.
 */
function breakLong(s: string, fits: (x: string) => boolean): string[] {
  if (fits(s)) return [s]
  const out: string[] = []
  let cur = ''
  for (const word of s.match(/\S+\s*/g) ?? [s]) {
    if (fits(cur + word)) { cur += word; continue }
    if (cur) { out.push(cur); cur = '' }
    let rest = Array.from(word)
    while (rest.length && !fits(rest.join(''))) {
      // the longest beginning that fits; at least one character, so it always moves on
      let lo = 1, hi = rest.length
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(rest.slice(0, mid).join(''))) lo = mid; else hi = mid - 1 }
      out.push(rest.slice(0, lo).join('')); rest = rest.slice(lo)
    }
    cur = rest.join('')
  }
  if (cur) out.push(cur)
  return out
}

export function cutTurn(turn: string, maxTokens: number, count: (s: string) => number): string[] {
  const m = /^([^:]{1,60}: )([\s\S]*)$/.exec(turn)
  const who = m?.[1] ?? '', words = m?.[2] ?? turn
  const fits = (x: string) => count(who + x.trim()) <= maxTokens
  const sentences = (words.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [words]).flatMap((s) => breakLong(s, fits))
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    const next = cur + s
    if (cur && count(who + next.trim()) > maxTokens) { out.push(who + cur.trim()); cur = s } else cur = next
  }
  if (cur.trim()) out.push(who + cur.trim())
  return out
}

/** the little words each language uses most, for telling a question's language without a model */
const COMMON: Record<string, string[]> = {
  English: ['the', 'a', 'an', 'and', 'is', 'was', 'of', 'to', 'what', 'we', 'it', 'about', 'did', 'who'],
  Spanish: ['el', 'la', 'los', 'las', 'que', 'qué', 'de', 'y', 'en', 'por', 'para', 'se', 'una', 'es', 'sobre', 'cuándo'],
  French: ['le', 'les', 'des', 'et', 'est', 'que', 'pour', 'une', 'dans', 'sur', 'qui', 'pas', 'du', 'quand'],
  German: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'wir', 'ein', 'eine', 'über', 'den', 'zu', 'mit', 'wurde', 'was'],
  Portuguese: ['o', 'os', 'as', 'que', 'de', 'e', 'não', 'uma', 'com', 'você', 'sobre', 'foi'],
  Italian: ['il', 'gli', 'che', 'di', 'e', 'non', 'una', 'per', 'con', 'sono', 'è', 'sul'],
  Dutch: ['het', 'een', 'en', 'is', 'niet', 'van', 'wat', 'we', 'zijn', 'over', 'werd'],
}

/** The language a text is in, by its script or its commonest little words; the fallback when it can't tell */
export function guessLanguage(text: string, fallback: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'Japanese'
  if (/\p{Script=Hangul}/u.test(text)) return 'Korean'
  if (/\p{Script=Han}/u.test(text)) return 'Chinese'
  const said = text.toLowerCase().match(/[\p{L}]+/gu) ?? []
  const scores = Object.entries(COMMON).map(([lang, list]) => [lang, said.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1])
  return scores[0][1] > 0 && scores[0][1] > scores[1][1] ? scores[0][0] : fallback
}

const LIST = /^\s*([-*+]|\d+[.)])\s+/
const STRUCTURE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s)/

/**
 * What the model wrote, without a "Here are your notes" first line, code fences, a closing remark after the last
 * bullet, or blank lines (in the editor a blank line is an empty paragraph, which notes never want)
 */
export function tidyNotes(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() && !/^\s*```/.test(l))
  const first = lines.findIndex((l) => STRUCTURE.test(l))
  if (first === -1) return lines.join('\n').trim()
  let last = lines.length - 1
  while (last > first && !STRUCTURE.test(lines[last]) && !/^\s{2,}\S/.test(lines[last])) last--
  return lines.slice(first, last + 1).join('\n').trim()
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n }

/** a typed line's words alone: no heading or list marker, also one the editor escaped ("2\. " typed as plain text) */
const bare = (l: string) => l.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*(\\?[-*+]|\d+\\?[.)])\s+/, '').replace(/\\(.)/g, '$1')

/**
 * A bullet that says what one of the person's own lines says (most of its words, and those make up a good part of
 * the bullet) is shown as theirs; one only loosely like it is not.
 */
export function markMine(md: string, mine: string): string {
  // and the other way: words the model marked as theirs that they typed nothing like are just notes
  const typed = mine.split('\n').map((l) => words(bare(l))).filter((w) => w.size)
  md = md.replace(/<mine>([\s\S]*?)<\/mine>/g, (m, x: string) => {
    const w = words(x)
    return typed.some((o) => overlap(o, w) / Math.max(1, Math.min(o.size, w.size)) >= 0.5) ? m : x
  })
  const own = typed.filter((w) => w.size >= 2)
  if (!own.length) return md
  const marked = [...md.matchAll(/<mine>([\s\S]*?)<\/mine>/g)].map((m) => words(m[1]))
  const open = own.filter((o) => !marked.some((m) => overlap(o, m) / o.size >= 0.6))
  return md.split('\n').map((line) => {
    const lead = LIST.exec(line)
    if (!lead || line.includes('<mine>') || !open.length) return line
    const body = line.slice(lead[0].length)
    const w = words(body.replace(/\*\*[^*]+:\*\*/, ''))
    const i = open.findIndex((o) => overlap(o, w) / o.size >= 0.6 && overlap(o, w) / Math.max(1, w.size) >= 0.4)
    if (i === -1) return line
    open.splice(i, 1)
    return `${lead[0]}<mine>${body}</mine>`
  }).join('\n')
}

/** a typed line that names what follows: a heading, "Goal:", or one in capitals ("CALL SCRIPT (first call)") */
const isLabel = (l: string) => {
  if (/^\s*#{1,6}\s/.test(l)) return true
  if (/^\s*(\\?[-*+]|\d+\\?[.)])\s/.test(l)) return false
  const outside = l.replace(/\([^)]*\)/g, '')
  return /:\s*$/.test(l) || (/\p{Lu}/u.test(outside) && !/\p{Ll}/u.test(outside))
}

/**
 * Their notes steer the summary and are never pasted into it, but a small model still copies some: a bullet that kept
 * their own marker ("- 2. …", "- - …") keeps one, and a bullet that is only one of their labels ("- CLOSE") goes.
 */
export function withoutCopies(md: string, mine: string): string {
  const fold = (s: string) => bare(s).replace(/<\/?mine>|\*\*|__/g, '').replace(/[:\s]+$/, '').trim().toLowerCase()
  const labels = new Set(mine.split('\n').filter((l) => l.trim() && isLabel(l)).map(fold))
  return md.split('\n').flatMap((line) => {
    const lead = LIST.exec(line)
    if (!lead) return [line]
    const body = line.slice(lead[0].length).replace(/^(<mine>)?(?:\\?[-*+]|\d+\\?[.)])\s+/, '$1')
    return labels.has(fold(body)) ? [] : [lead[0] + body]
  }).join('\n')
}

/** a "- **Name:** task" bullet */
const OWNER = /^\s*[-*]\s+\*\*[^*\n]+:\*\*/m

const nextStepsPrompt = (language: string) =>
  `Now write only the "## Next steps" section (heading in ${language || 'the same language'}): one bullet per thing someone will do after the meeting, as "- **Name:** what they will do, by when" (the when only if it was said), "You" for the person these notes are for, and plain words for who they are for someone without a name ("Them" is not a name). If nobody is to do anything, answer only NONE. Nothing else.`

export type EnhanceInput = {
  meeting: { title: string; attendees: Person[] }; mine: string; segments: Segment[]; language: string | null
  /** the person who recorded it */
  me?: string
  /** the meeting's names and companies: the transcript is respelled with them, and the model told how they are spelled */
  words?: MeetingWords
  /**
   * Gets a way to ask for a title from these notes, once they are written: called after they are saved (as a job of its
   * own, with that job's model), so the title never holds them back. It answers '' when the model gives nothing useful or fails.
   */
  titleLater?: (ask: (llm: Llm) => Promise<string>) => void
}

/** a title's most characters; a longer answer is cut at a word */
export const TITLE_CHARS = 80

/** asked after the notes, following on from them: the model has read the meeting already, so this costs a few words */
export const titlePrompt = (language: string) =>
  `Now give this meeting a title, in ${language || 'the same language as the notes'}: short and specific, saying what it was about, and with whom when a name is known, like "Q3 hiring plan with Maya" or "Fixing the checkout bug". Under 70 characters, no quotes, no period at the end. Answer with the title only.`

/** the title as the model wrote it, without quotes, a "Title:" label, heading or bold marks, or a closing period */
export function cleanTitle(raw: string): string {
  let s = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  s = s.replace(/^#+\s*/, '').replace(/^(?:\*\*)?title(?:\*\*)?\s*:\s*/i, '').replace(/\*\*|__/g, '').trim()
  s = s.replace(/^["'“”‘’«»「」『』]+|["'“”‘’«»「」『』]+$/g, '').trim().replace(/[.。]+$/, '').trim()
  if (/^none$/i.test(s)) return ''
  if (s.length > TITLE_CHARS) s = s.slice(0, TITLE_CHARS + 1).replace(/\s+\S*$/, '').replace(/[,;:\s-]+$/, '')
  return s
}

/** the most transcript (in tokens) the notes prompt holds whole, with room for the notes */
export async function wholeBudget(llm: Pick<Llm, 'count' | 'contextSize'>, language: string, mine = ''): Promise<number> {
  const [overhead] = await llm.count([enhancePrompt({ title: '', attendees: [], mine, transcript: '', language, minutes: 60 })])
  return llm.contextSize - overhead - NOTES_TOKENS
}

/** the biggest part of a long meeting, in tokens */
export async function partBudget(llm: Pick<Llm, 'count' | 'contextSize'>, language: string): Promise<number> {
  const [overhead] = await llm.count([summaryPrompt('', 1, language)])
  return Math.max(500, Math.min(MAX_PART_TOKENS, llm.contextSize - overhead - SUMMARY_TOKENS - 64))
}

/** the earlier parts that cover the transcript's first lines, as long as they match it line for line */
export function reusable(lines: string[], earlier: PartSummary[]): PartSummary[] {
  const out: PartSummary[] = []
  let at = 0
  for (const p of earlier) {
    if (!p.lines.length || p.lines.some((l, k) => lines[at + k] !== l)) break
    out.push(p); at += p.lines.length
  }
  return out
}

/** under this share of the words from the computer's sound, nobody was on a call: a room heard on the mic (a standup had 1%) */
const ONE_MIC_SHARE = 0.1
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length
function oneMic(segments: Segment[]): boolean {
  let me = 0, them = 0
  for (const s of segments) if (s.track === 'me') me += wordCount(s.text); else them += wordCount(s.text)
  return me > 0 && them < (me + them) * ONE_MIC_SHARE
}

/**
 * The notes for one meeting. When the transcript fits the model's context it is read whole; otherwise each part is
 * summarised first and the notes are written from the summaries (in order) plus the person's own notes.
 * earlier: parts summarised while the meeting was recorded; those still matching the transcript are used as they are.
 */
export async function enhance(input: EnhanceInput, llm: Llm, onToken: (text: string) => void, onPart?: (part: number, of: number) => void, earlier: PartSummary[] = []): Promise<string> {
  const language = languageName(input.language)
  let first = Infinity, last = -Infinity
  for (const s of input.segments) { first = Math.min(first, s.startMs); last = Math.max(last, s.endMs) }
  const minutes = input.segments.length ? (last - first) / 60_000 : undefined
  const base = { title: input.meeting.title, attendees: input.meeting.attendees, mine: input.mine, language, minutes, me: input.me, spelling: input.words && spellingLine(input.words), oneMic: oneMic(input.segments) }
  const segments = input.words ? input.segments.map((x) => ({ ...x, text: respell(x.text, input.words!) })) : input.segments
  let transcript = transcriptText(segments)
  let parts = false

  for (let round = 0; round < 3; round++) {
    const lines = transcript.split('\n')
    const done = round === 0 ? reusable(lines, earlier) : []
    const [overhead, ...lineTokens] = await llm.count([enhancePrompt({ ...base, transcript: '', parts }), ...lines])
    const total = lineTokens.reduce((a, b) => a + b + 1, 0)
    // parts summarised during the meeting mean it was too long already: those are used even if it fits now
    if (!done.length && overhead + total + NOTES_TOKENS <= llm.contextSize) break
    const max = await partBudget(llm, language)
    const from = done.reduce((n, p) => n + p.lines.length, 0)
    const rest = lineTokens.slice(from).reduce((a, b) => a + b + 1, 0)
    // even parts read better than one full part and a scrap
    const target = Math.min(max, Math.ceil(rest / Math.ceil(rest / max)) + 256)
    const known = new Map(lines.map((l, i) => [l, lineTokens[i]]))
    const count = (s: string) => known.get(s) ?? roughTokens(s)
    const pieces = from < lines.length ? splitForContext(lines.slice(from).join('\n'), target, count) : []
    const summaries = done.map((p) => p.summary)
    for (const piece of pieces) {
      const n = summaries.length + 1
      onPart?.(n, done.length + pieces.length)
      summaries.push(tidyNotes(await llm.chat(summaryPrompt(piece, n, language), () => {}, { summary: true, maxTokens: SUMMARY_TOKENS })))
    }
    transcript = summaries.map((s, i) => `Part ${i + 1}:\n${s}`).join('\n')
    parts = true
  }

  const prompt = enhancePrompt({ ...base, transcript, parts })
  let md = tidyNotes(await llm.chat(prompt, onToken, { maxTokens: NOTES_TOKENS }))
  const written = md
  // the model sometimes stops before the next steps (it samples): ask for just that part, after what it wrote. Notes
  // with three sections or more and still none had none to give
  if (md && !OWNER.test(md) && (md.match(/^## /gm) ?? []).length < 3) {
    // shown as it is written only once it starts like the section, so a chatty answer never flashes up
    let held = '', showing = false
    const show = (t: string) => {
      if (showing) { onToken(t); return }
      held += t
      if (held.trimStart().startsWith('#')) { showing = true; onToken(`\n${held.trimStart()}`) }
    }
    const more = tidyNotes(await llm.chat(nextStepsPrompt(language), show, { maxTokens: 400, before: [prompt, md] }))
    // only a real next-steps list is kept; anything else it said is dropped
    if (OWNER.test(more)) md = `${md}\n${more}`
  }
  // a title is nice to have: one that fails or comes out empty leaves the meeting's as it is
  if (written) input.titleLater?.((model) => model.chat(titlePrompt(language), () => {}, { maxTokens: 40, before: [prompt, written], temperature: 0.3 })
    .then((raw) => cleanTitle(raw), (e) => { console.error('a title from the notes failed', e); return '' }))
  return markMine(withoutCopies(md, input.mine), input.mine)
}
