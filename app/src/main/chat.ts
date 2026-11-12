import type { Meeting, Notes, Segment, Store } from './store'
import type { NotesModel } from './notes/model'
import type { Queue } from './notes/queue'
import { transcriptHead, transcriptText } from './notes/enhance'
import { meetingWords, respell, spellingLine } from './vocab'
import type { AskStep, ChatTurn, ChatView } from '../shared/types'

/**
 * Chat with one meeting: a question answered by the notes model from the meeting's transcript and notes.
 * The prompt starts exactly like the notes prompt and the read ahead (transcriptHead + the transcript), so a question
 * during or after a meeting only reads what is new: the model already holds the transcript. Anything about the
 * question comes last. Prompts go to the model and are never translated.
 */

/** the longest answer */
export const ANSWER_TOKENS = 1024
/** earlier questions carried along: enough to follow up, not so many that they crowd the transcript */
export const HISTORY_TURNS = 6
/** room kept for the tokenizer guessing low */
const MARGIN_TOKENS = 256
/** the answer goes to the window at most this often while it is written */
const SEND_EVERY_MS = 50

/** how a transcript cut to the parts that matter starts */
export const excerptHead = 'Here are parts of the transcript of a meeting, the ones that matter most to the question below ("…" is where lines were left out). Each line starts with who said it: "You" is the person who recorded it, a name is someone on the call, and "Them" is the other side of the call when no name is known.\n<transcript>\n'
/**
 * The most transcript a meeting too long to read whole gets for one question. Filling the whole window instead
 * (~31k tokens) took the notes model almost two minutes before the first word; 8k takes about 15 s, and a blind
 * check on a 2.5-hour meeting rated its answers only a little less correct.
 */
export const EXCERPT_TOKENS = 8000
/** the best matches widened around first, so lines that share only a common word don't take all the room */
const TOP_HITS = 3
/** matches used at all */
const HITS_USED = 8

type Count = (s: string) => number
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
/** a safe guess at tokens where the model's count isn't known: Chinese, Japanese and Korean take about one a character */
const guess: Count = (s) => { const n = s.match(CJK)?.length ?? 0; return n + Math.ceil((s.length - n) / 3) }

/** turns as the notes prompt has them, with the lines under each */
function turnsOf(segments: Segment[]): Array<{ text: string; ids: number[] }> {
  const groups: Segment[][] = []
  const who = (s: Segment) => (s.track === 'me' ? 'me' : s.speaker ?? '')
  for (const s of segments) {
    const last = groups.at(-1)
    if (last && who(last[0]) === who(s)) last.push(s); else groups.push([s])
  }
  return groups.map((g) => ({ text: transcriptText(g), ids: g.map((s) => s.id) }))
}

/** What follows the transcript: the meeting, and its notes (the enhanced ones, or what the person typed while there are none yet) */
export function contextTail(meeting: Pick<Meeting, 'title' | 'attendees'>, notes: Notes, spelling = ''): string {
  const people = meeting.attendees.map((a) => a.name).filter(Boolean)
  const written = notes.enhanced?.trim()
  const mine = notes.mine.trim()
  return [
    '</transcript>',
    '',
    `Meeting: ${meeting.title || 'Untitled'}`,
    `People invited: ${people.length ? people.join(', ') : 'not known'}.`,
    ...(spelling ? [spelling] : []),
    ...(written ? ['', 'The notes on this meeting:', '<notes>', written, '</notes>']
      : mine ? ['', 'Notes the person typed during the meeting:', '<notes>', mine, '</notes>'] : []),
  ].join('\n')
}

/**
 * What the model reads to answer: the transcript, then the meeting and its notes (the enhanced ones, or
 * what the person typed while there are none yet). The whole transcript when it fits maxTokens; otherwise the turns
 * around the lines that say the question's words (hits, best first, from store.segmentHits), or the latest turns
 * when none do.
 */
export function chatContext(
  meeting: Pick<Meeting, 'title' | 'attendees'>, notes: Notes, segments: Segment[], maxTokens: number,
  o: { hits?: number[]; count?: Count; spelling?: string } = {},
): string {
  const count = o.count ?? guess
  const tail = contextTail(meeting, notes, o.spelling)
  const turns = turnsOf(segments)
  const whole = transcriptHead + turns.map((t) => t.text).join('\n') + '\n' + tail
  const cost = (s: string) => count(s) + 1
  if (count(transcriptHead) + turns.reduce((n, t) => n + cost(t.text), 0) + count(tail) <= maxTokens) return whole

  const budget = Math.min(EXCERPT_TOKENS, maxTokens - count(excerptHead) - count(tail))
  // a turn too big to share the room (a long monologue) is offered line by line
  const units = turns.flatMap((t) => {
    if (cost(t.text) <= budget / 4 || t.ids.length < 2) return [t]
    return t.ids.map((id) => ({ text: transcriptText(segments.filter((s) => s.id === id)), ids: [id] }))
  })
  const at = new Map(units.flatMap((u, i) => u.ids.map((id) => [id, i] as const)))
  const hit = [...new Set((o.hits ?? []).map((id) => at.get(id)).filter((i): i is number => i != null))].slice(0, HITS_USED)
  const chosen = new Set<number>()
  let used = 0
  const take = (i: number) => {
    if (i < 0 || i >= units.length || chosen.has(i)) return
    const n = cost(units[i].text)
    if (used + n > budget) return
    chosen.add(i); used += n
  }
  if (hit.length) {
    // the best few with the turns around them first, then each hit, widening while there is room
    for (const h of hit.slice(0, TOP_HITS)) for (let r = 0; r <= 2; r++) { take(h - r); if (r) take(h + r) }
    for (let r = 0; r < units.length && used < budget; r++) for (const h of hit) { take(h - r); if (r) take(h + r) }
  } else {
    for (let i = units.length - 1; i >= 0 && used < budget; i--) take(i)
  }
  const kept = [...chosen].sort((a, b) => a - b)
  const lines: string[] = []
  kept.forEach((i, k) => {
    if (i > (k ? kept[k - 1] + 1 : 0)) lines.push('…')
    lines.push(units[i].text)
  })
  if (kept.length && kept.at(-1)! < units.length - 1) lines.push('…')
  return excerptHead + lines.join('\n') + '\n' + tail
}

export type History = Array<{ question: string; answer: string }>

/**
 * The start of every question's prompt about this meeting: nothing in it depends on the question, the history or
 * the recording, so warm() reads it in before anything is asked.
 */
export const chatPrefix = (context: string): string => context + '\n'

export function chatPrompt(i: { context: string; question: string; history: History; recording: boolean }): string {
  return chatPrefix(i.context) + [
    '',
    ...(i.recording ? ['The meeting is still going on: the transcript is what has been said so far.'] : []),
    'Answer the question below about this meeting, for the person who recorded it ("You" in the transcript).',
    ...(i.history.length ? ['', 'Earlier in this chat:', ...i.history.flatMap((h) => ['<asked>', h.question, '</asked>', '<answered>', h.answer, '</answered>'])] : []),
    '',
    'How to answer:',
    '- Answer in the language the question is written in.',
    '- Use only what was said in the meeting and what is in the notes. If the answer is not there, say so in a sentence. Never make anything up.',
    '- Be brief and direct: a sentence or two, or short "- " bullets for a list. **Bold** only the key facts. No headings, no introduction, no closing line.',
    '- People: call them by their name when it is known, and "you" for the person asking. "Them" in the transcript is not a name: for anyone without one, say who they are in plain words from what they said or do (like "the designer", "the client"), or leave out who said it. Never make up a name.',
    '- When asked to write something (an email, a message, a summary), write it in full, ready to use.',
    '',
    '<question>',
    i.question,
    '</question>',
  ].join('\n')
}

type Deps = { store: Pick<Store, 'meeting' | 'notes' | 'segments' | 'segmentHits'>; queue: Pick<Queue, 'enqueue'>; model: Pick<NotesModel, 'llm'> & Partial<Pick<NotesModel, 'needsLoad'>> }
type Model = Awaited<ReturnType<NotesModel['llm']>>

/** What the model reads about the meeting for this question, sized to the room left by the question and history */
async function prepare(d: Pick<Deps, 'store'>, llm: Model, m: Meeting, question: string, history: History, recording: boolean): Promise<{ context: string; recent: History }> {
  const total = llm.contextSize - ANSWER_TOKENS - MARGIN_TOKENS
  // the notes take at most a quarter of the room: long ones are cut at a line
  let notes = d.store.notes(m.id)
  const words = meetingWords(m)
  const spelling = spellingLine(words)
  let [tailTokens] = await llm.count([contextTail(m, notes, spelling)])
  if (tailTokens > total / 4) {
    const cut = (t: string) => { const keep = Math.floor(t.length * (total / 4 / tailTokens) * 0.9); return t.slice(0, keep).replace(/\n[^\n]*$/, '') + '\n…' }
    notes = notes.enhanced?.trim() ? { ...notes, enhanced: cut(notes.enhanced) } : { ...notes, mine: cut(notes.mine) }
    ;[tailTokens] = await llm.count([contextTail(m, notes, spelling)])
  }
  // earlier questions go oldest first until at least half the room is left for the transcript
  let recent = history.slice(-HISTORY_TURNS)
  const overheadOf = async () => (await llm.count([chatPrompt({ context: '', question, history: recent, recording })]))[0]
  let overhead = await overheadOf()
  while (recent.length && overhead + tailTokens > total / 2) { recent = recent.slice(1); overhead = await overheadOf() }
  // the turns, heads and tail counted by the model's own tokenizer, so a transcript that fits is read whole
  // lines saved before the meeting had these people get their spellings too
  const segments = d.store.segments(m.id).map((x) => ({ ...x, text: respell(x.text, words) }))
  const tail = contextTail(m, notes, spelling)
  const texts = [...new Set([transcriptHead, excerptHead, tail, ...transcriptText(segments).split('\n')])]
  const counted = await llm.count(texts)
  const known = new Map(texts.map((l, k) => [l, counted[k]]))
  const count: Count = (s) => known.get(s) ?? guess(s)
  const hits = question.trim() ? d.store.segmentHits(m.id, question) : []
  return { context: chatContext(m, notes, segments, total - overhead, { hits, count, spelling }), recent }
}

/**
 * Reads the meeting into the model before a question about it (its Ask opened): the start of the prompt ask() will
 * send, so the question then only reads itself. A read ahead in the queue (lowest priority, dropped for anything
 * else). Only when the whole transcript fits: otherwise the context is cut to fit the question. Loads the model.
 */
export function warm(d: Deps, meetingId: string): Promise<void> {
  return d.queue.enqueue(async (signal) => {
    const m = d.store.meeting(meetingId)
    if (!m) return
    const llm = await d.model.llm(signal)
    if (!llm.readAhead || signal.aborted) return
    const { context } = await prepare(d, llm, m, '', [], m.state === 'recording')
    if (signal.aborted || !context.startsWith(transcriptHead)) return
    await llm.readAhead(chatPrefix(context), signal)
  }, 'readahead', meetingId)
}

/**
 * One question about a meeting, answered through the model queue as a `chat` job (recording comes first: on a small
 * Mac it waits for the meeting to end; a read ahead gives way to it). Streams the answer. A stop (signal) ends it
 * quietly. When the queue stops the job (a recording needs the room) it runs again from the start: onRestart.
 * onStep: what it is doing before the first words (loading the model, then reading the meeting).
 */
export async function* ask(d: Deps, meetingId: string, question: string, history: History,
  o: { signal?: AbortSignal; onStart?: () => void; onRestart?: () => void; onComplete?: (answer: string) => void; onStep?: (step: AskStep) => void } = {}): AsyncIterable<string> {
  const buf: string[] = []
  let wake: (() => void) | undefined
  let done = false, failed: unknown
  const push = (t: string) => { buf.push(t); wake?.() }
  const finish = (e?: unknown) => { if (done) return; failed = e; done = true; wake?.() }
  // a stop ends it at once, even while it still waits in the queue (the job then does nothing when its turn comes)
  o.signal?.addEventListener('abort', () => finish(), { once: true })

  d.queue.enqueue(async (stop) => {
    if (o.signal?.aborted) return
    const signal = o.signal ? AbortSignal.any([stop, o.signal]) : stop
    o.onStart?.()
    try {
      const m = d.store.meeting(meetingId)
      if (!m) throw new Error('No such meeting')
      if (d.model.needsLoad?.()) o.onStep?.({ kind: 'loading' })
      const llm = await d.model.llm(signal)
      const recording = m.state === 'recording'
      const { context, recent } = await prepare(d, llm, m, question, history, recording)
      if (signal.aborted) return
      o.onStep?.({ kind: 'reading', title: m.title })
      // the engine ends an answer it is told to stop and returns what it had (no error)
      const answer = await llm.chat(chatPrompt({ context, question, history: recent, recording }), (t) => { if (!signal.aborted) push(t) }, { maxTokens: ANSWER_TOKENS })
      if (!signal.aborted) o.onComplete?.(answer)
    } catch (e) {
      // stopped by the person: what was written stands
      if (o.signal?.aborted && !stop.aborted) return
      throw e
    } finally {
      // stopped by the queue alone (a recording needs the room): it starts over later, so what was written goes.
      // Stopped by the person too: it stays stopped.
      if (stop.aborted && !o.signal?.aborted) { buf.length = 0; o.onRestart?.() }
    }
  }, 'chat', meetingId).then(() => finish(), finish)

  while (true) {
    if (buf.length) { yield buf.shift()!; continue }
    if (done) break
    await new Promise<void>((r) => { wake = r })
    wake = undefined
  }
  if (failed && !o.signal?.aborted) throw failed
}

/**
 * Each meeting's chat as the window shows it: kept in the store (questions and finished answers), the answer being
 * written streamed to the window. One question at a time per meeting.
 */
export function hookChat(p: Deps & {
  store: Pick<Store, 'chatTurns' | 'addChatTurn' | 'setChatAnswer' | 'deleteChatTurn' | 'clearChat'>
  send: (v: ChatView) => void
  /** a small Mac is recording: answers wait for the meeting to end */
  waitsForMeeting: () => boolean
  /** first run: the notes model is still downloading, so answers wait for it */
  waitsForModel?: () => boolean
}) {
  const chats = new Map<string, ChatTurn[]>()
  const running = new Map<string, AbortController>()
  /** turns not saved (the meeting is gone) still need a key in the window */
  let unsaved = 0
  const turns = (id: string) => {
    let list = chats.get(id)
    if (!list) {
      // an answer that never finished (a quit) is not kept; one the person stopped is, as stopped
      list = p.store.chatTurns(id).filter((t) => t.answer || t.stopped)
        .map((t) => ({ id: t.id, question: t.question, answer: t.answer, status: t.stopped ? 'stopped' as const : 'done' as const }))
      chats.set(id, list)
    }
    return list
  }
  const view = (id: string): ChatView => ({ meetingId: id, turns: turns(id).map((t) => ({ ...t })), waitsForMeeting: p.waitsForMeeting(), waitsForModel: p.waitsForModel?.() ?? false })

  return {
    view,
    async ask(id: string, raw: string) {
      const question = raw.trim().slice(0, 4000)
      if (!question || running.has(id)) return
      const list = turns(id)
      // asking again after a failure replaces the failed turn
      while (list.at(-1)?.status === 'failed') list.pop()
      // only full answers follow on: a stopped one may be cut mid-sentence
      const history = list.filter((t) => t.status === 'done' && t.answer).map((t) => ({ question: t.question, answer: t.answer }))
      const turn: ChatTurn = { id: --unsaved, question, answer: '', status: 'waiting' }
      list.push(turn)
      const ac = new AbortController()
      running.set(id, ac)
      let timer: NodeJS.Timeout | undefined, last = 0
      const flush = () => { timer = undefined; last = Date.now(); p.send(view(id)) }
      const later = () => {
        if (timer) return
        const wait = SEND_EVERY_MS - (Date.now() - last)
        if (wait <= 0) flush(); else timer = setTimeout(flush, wait)
      }
      let saved = false
      let written = ''
      let completed: string | undefined
      try {
        turn.id = p.store.addChatTurn(id, question)
        saved = true
        p.send(view(id))
        for await (const t of ask(p, id, question, history, {
          signal: ac.signal,
          onStart: () => { turn.status = 'answering'; later() },
          onRestart: () => { written = ''; completed = undefined; turn.answer = ''; turn.status = 'waiting'; later() },
          onComplete: (answer) => { completed = answer },
        })) { written += t; turn.answer = written; later() }
        // Final cleanup may remove text already streamed; stopped answers keep only what arrived before Stop.
        turn.answer = (completed ?? written).trim()
        turn.status = ac.signal.aborted ? 'stopped' : 'done'
        p.store.setChatAnswer(turn.id, turn.answer, turn.status === 'stopped')
      } catch (e) {
        console.error('answering a question failed', id, e)
        turn.status = 'failed'
        if (saved) p.store.deleteChatTurn(turn.id)
      } finally {
        if (timer) clearTimeout(timer)
        if (running.get(id) === ac) running.delete(id)
        // cleared meanwhile: nothing to show
        if (chats.get(id) === list) p.send(view(id))
      }
    },
    stop(id: string) { running.get(id)?.abort() },
    /** the windows hear again what every open chat waits for (the notes model arrived) */
    refresh() { for (const id of chats.keys()) p.send(view(id)) },
    /** the meeting was deleted: any answer stops, and nothing of it is kept here */
    forget(id: string) { running.get(id)?.abort(); running.delete(id); chats.delete(id) },
    clear(id: string) {
      running.get(id)?.abort()
      running.delete(id)
      p.store.clearChat(id)
      chats.set(id, [])
      p.send(view(id))
    },
  }
}
export type Chat = ReturnType<typeof hookChat>
