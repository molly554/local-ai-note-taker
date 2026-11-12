import { peopleRule } from '../notes/enhance'
import { clock } from '../../shared/transcript'
import type { Item } from './retrieve'
import { CITE } from '../../shared/citations'

/**
 * The prompt for a question across meetings. It starts with the same instructions every time, byte for byte, so the
 * model keeps them read from one question to the next and only reads the sources and question that follow. Anything
 * that changes (the sources, the day, earlier turns, the question) comes after. Prompts go to the model and are never
 * translated.
 */
export const libraryHead = [
  'You answer questions about the person\'s own meetings. After these instructions come parts of their meetings that were found for the question, grouped by meeting, each part numbered like [1]: pieces of transcripts, or the notes written after a meeting. In a transcript each line starts with who said it: "You" is the person asking, a name is someone on the call, and "Them" is the other side of the call when no name is known.',
  '',
  'How to answer:',
  '- Answer in the language the question is written in.',
  '- Use only what is in the sources. If they don\'t hold the answer, say so in a sentence, with no numbers. Never make anything up.',
  '- After each fact, put the number of the source it came from in square brackets, like [2]. Use only the numbers given.',
  '- Be brief and direct: a sentence or two, or short "- " bullets for a list. **Bold** only the key facts. No headings, no introduction, no closing line.',
  peopleRule.replace('the person these notes are for', 'the person asking'),
  '- When asked to write something (an email, a message, a summary), write it in full, ready to use.',
  '',
  '<sources>',
  '',
].join('\n')

const day = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

export const meetingLabel = (i: Pick<Item, 'title' | 'startedAt'>): string => `Meeting: ${i.title || 'Untitled'} · ${day(i.startedAt)}`

export function sourceLabel(i: Pick<Item, 'atMs'>, n: number): string {
  return `[${n}] ${i.atMs == null ? 'the meeting notes' : `${clock(i.atMs)} into the meeting`}`
}

/**
 * The sources meeting by meeting (best meeting first, its parts in the order they were said), so the model sees
 * meetings, not loose pieces: five parts of one call are one call when it counts or cites them.
 */
export function byMeeting(items: Item[]): Item[] {
  const groups = new Map<string, Item[]>()
  for (const it of items) groups.set(it.meetingId, [...(groups.get(it.meetingId) ?? []), it])
  return [...groups.values()].flatMap((g) => g.sort((a, b) => (a.atMs ?? -1) - (b.atMs ?? -1)))
}

/** each meeting's heading, then its numbered parts */
function sourcesText(items: Item[]): string {
  const meetings = new Set(items.map((i) => i.meetingId)).size
  const parts = items.map((it, k) => `${k === 0 || items[k - 1].meetingId !== it.meetingId ? `${meetingLabel(it)}\n` : ''}${sourceLabel(it, k + 1)}\n${it.text}`)
  return `These come from ${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}.\n\n${parts.join('\n\n')}`
}

const uncited = (answer: string) => answer.replace(CITE, '').replace(/ +([.,;:!?])/g, '$1').replace(/ {2,}/g, ' ').trim()

export type History = Array<{ question: string; answer: string }>

export function libraryPrompt(i: { items: Item[]; question: string; history: History; now: number; spelling: string }): string {
  return [
    libraryHead + (i.items.length ? sourcesText(i.items) : 'No meetings matched this question.'),
    '</sources>',
    '',
    `Today is ${day(i.now)}.`,
    ...(i.spelling ? [i.spelling] : []),
    'Answer the question below from the sources, with their numbers like [1].',
    ...(i.history.length ? ['', 'Earlier in this chat:', ...i.history.flatMap((h) => ['<asked>', h.question, '</asked>', '<answered>', uncited(h.answer), '</answered>'])] : []),
    '',
    '<question>',
    i.question,
    '</question>',
  ].join('\n')
}
