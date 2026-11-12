import type { Store } from '../store'
import type { NotesModel } from '../notes/model'
import type { Queue } from '../notes/queue'
import { ask as askMeeting, warm as warmMeeting, HISTORY_TURNS, ANSWER_TOKENS } from '../chat'
import { meetingWords, respell, spellingLine } from '../vocab'
import type { ConversationSummary, ConversationTurn, ConversationView, LibrarySource } from '../../shared/types'
import type { Library } from './store'
import type { Indexer } from './indexer'
import type { Embedder } from './embedder'
import { retrieve, type Item } from './retrieve'
import { byMeeting, libraryPrompt, type History } from './prompt'
import { citedIn, tidyCitations } from '../../shared/citations'
import { attachContext } from '../../shared/askContext'

/** room kept for the tokenizer guessing low */
const MARGIN_TOKENS = 256
/** the answer goes to the window at most this often while it is written */
const SEND_EVERY_MS = 50
/** a conversation is named after its first question, cut at a word */
const TITLE_CHARS = 56
/** opening the same meeting's Ask again within this reads nothing more */
const WARM_AGAIN_MS = 30_000

export const titleOf = (q: string) => {
  const one = q.replace(/\s+/g, ' ').trim()
  return one.length <= TITLE_CHARS ? one : one.slice(0, TITLE_CHARS).replace(/\s+\S*$/, '') + '…'
}

type Deps = {
  store: Pick<Store, 'meeting' | 'notes' | 'segments' | 'segmentHits' | 'speakerOrder'>; library: Library; indexer: Pick<Indexer, 'ensure' | 'vectors'>; embedder: Pick<Embedder, 'query' | 'ready'>
  queue: Pick<Queue, 'enqueue'>; model: Pick<NotesModel, 'llm'> & Partial<Pick<NotesModel, 'needsLoad'>>
  send: (v: ConversationView) => void
  sendList: (l: ConversationSummary[]) => void
  /** a small Mac is recording: answers wait for the meeting to end */
  waitsForMeeting: () => boolean
  /** first run: the notes model is still downloading */
  waitsForModel: () => boolean
  /** reading a meeting in ahead of a question is fine now (no recording that needs the room) */
  warmAllowed?: () => boolean
  now?: () => number
}

/**
 * Chat across meetings: saved conversations, each question answered through the model queue as a `chat` job
 * (recording still comes first), from what retrieve() finds. The answer streams to the window with its sources, so
 * citations become links as they arrive. One question at a time per conversation.
 */
export function hookConversations(p: Deps) {
  const now = p.now ?? Date.now
  const open = new Map<string, ConversationTurn[]>()
  const running = new Map<string, AbortController>()
  const turns = (id: string) => {
    let list = open.get(id)
    if (!list) {
      // Only a question that was waiting for the download resumes after a restart.
      list = p.library.turns(id)
        .map((t) => ({ id: t.id, question: t.question, answer: t.answer, status: t.waitingModel ? 'waiting' as const : t.stopped || !t.answer ? 'stopped' as const : 'done' as const, sources: t.sources }))
      open.set(id, list)
    }
    return list
  }
  const view = (id: string): ConversationView | undefined => {
    const c = p.library.conversation(id)
    return c && { id, title: c.title, chips: p.library.describe(c.chips), draftChips: p.library.describe(c.firstChips === null ? c.chips : c.draftChips), firstChips: c.firstChips === null ? null : p.library.describe(c.firstChips), draft: c.draft, turns: turns(id).map((t) => ({ ...t, sources: [...t.sources] })), waitsForMeeting: p.waitsForMeeting(), waitsForModel: p.waitsForModel() }
  }
  const list = (): ConversationSummary[] => p.library.conversations().map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, chips: p.library.describe(c.chips), draft: c.draft }))
  const push = (id: string) => { const v = view(id); if (v) p.send(v) }
  /** when each meeting was last read in ahead (or is being): opening it again soon after does nothing */
  const warmed = new Map<string, number>()
  /** the one meeting a conversation is about, or none */
  const singleOf = (chips: import('../../shared/askContext').ContextChip[]) => {
    const scope = p.library.scope(chips)
    return chips.length === 1 && chips[0].kind === 'meeting' && scope?.length === 1 ? scope[0] : undefined
  }

  /** the sources that fit the room left, best first; a single one too big is cut */
  async function fit(llm: Awaited<ReturnType<NotesModel['llm']>>, items: Item[], question: string, history: History, spelling: string): Promise<{ items: Item[]; history: History }> {
    const total = llm.contextSize - ANSWER_TOKENS - MARGIN_TOKENS
    let recent = history.slice(-HISTORY_TURNS)
    const size = async (its: Item[], h: History) => (await llm.count([libraryPrompt({ items: its, question, history: h, now: now(), spelling })]))[0]
    // earlier turns go oldest first until they take at most a quarter of the room
    while (recent.length && (await size([], recent)) - (await size([], [])) > total / 4) recent = recent.slice(1)
    const base = await size([], recent)
    const each = await llm.count(items.map((i) => `${i.title} ${i.text}`))
    const kept: Item[] = []
    let used = base
    for (const [k, it] of items.entries()) {
      const n = each[k] + 24
      if (used + n <= total) { kept.push(it); used += n; continue }
      if (!kept.length) kept.push({ ...it, text: it.text.slice(0, Math.max(200, Math.floor(it.text.length * (total - used) / n))) + '\n…' })
      break
    }
    return { items: kept, history: recent }
  }

  /** A resumed question keeps its saved turn and context. */
  function ask(id: string | null, raw: string, o: { scope?: string[] } = {}, resume?: number): { id: string; done: Promise<void> } {
    const question = raw.trim().slice(0, 4000)
    if (id && !p.library.conversation(id)) throw new Error('Conversation not found')
    if (id && running.has(id)) throw new Error('An answer is already running')
    if (!question) return { id: id ?? '', done: Promise.resolve() }
    const cid = id ?? p.library.current([], true)
    if (!p.library.conversation(cid)?.title) p.library.renameConversation(cid, titleOf(question))
    const conversation = p.library.conversation(cid)!
    const chips = attachContext(conversation.chips, conversation.draftChips)
    const scope = p.library.scope(chips) ?? o.scope
    const single = singleOf(chips)
    const all = turns(cid)
    // asking again after a failure replaces the failed turn
    while (all.at(-1)?.status === 'failed') all.pop()
    // only full answers follow on: a stopped one may be cut mid-sentence
    const done = all.filter((t) => t.status === 'done' && t.answer)
    const history = done.map((t) => ({ question: t.question, answer: t.answer }))
    const turn: ConversationTurn = resume === undefined
      ? { id: p.library.addTurn(cid, question, now(), p.waitsForModel()), question, answer: '', status: 'waiting', sources: [] }
      : all.find(t => t.id === resume)!
    if (resume === undefined) all.push(turn)
    const ac = new AbortController()
    running.set(cid, ac)
    p.sendList(list())
    push(cid)

    let timer: NodeJS.Timeout | undefined, last = 0, over = false
    const flush = () => { timer = undefined; last = Date.now(); if (!over) push(cid) }
    const later = () => {
      // a stopped job can still be finishing in the queue: the turn is settled, nothing more to show
      if (timer || over) return
      const wait = SEND_EVERY_MS - (Date.now() - last)
      if (wait <= 0) flush(); else timer = setTimeout(flush, wait)
    }
    let written = '', completed: string | undefined
    const job = single ? (async () => {
      for await (const text of askMeeting(p, single, question, history, {
        signal: ac.signal,
        onStart: () => { p.library.startTurn(turn.id); turn.status = 'answering'; later() },
        onStep: (step) => { turn.step = step; later() },
        onRestart: () => { written = ''; completed = undefined; turn.answer = ''; turn.status = 'waiting'; turn.step = undefined; later() },
        onComplete: answer => { completed = answer },
      })) { written += text; turn.answer = written; later() }
    })() : p.queue.enqueue(async (stop) => {
      if (ac.signal.aborted) return
      const signal = AbortSignal.any([stop, ac.signal])
      p.library.startTurn(turn.id)
      turn.status = 'answering'; turn.step = { kind: 'searching' }; later()
      try {
        const got = await retrieve(p, question, { now: now(), scope, context: done.at(-1)?.question })
        if (p.model.needsLoad?.()) { turn.step = { kind: 'loading' }; later() }
        const llm = await p.model.llm(signal)
        // the names of every meeting found, spelled right
        const words = got.items.map((i) => p.store.meeting(i.meetingId)).filter((m) => !!m).map((m) => meetingWords(m))
        // the person's jargon too, found meetings or none
        const { jargon } = meetingWords({ title: '', titleSource: 'generic', attendees: [] })
        const spelling = spellingLine({ title: '', names: words.flatMap((w) => w.names), companies: words.flatMap((w) => w.companies), ...(jargon ? { jargon } : {}) })
        const fitted = await fit(llm, got.items, question, history, spelling)
        const items = byMeeting(fitted.items), recent = fitted.history
        turn.sources = items.map((i, k): LibrarySource => {
          const source: LibrarySource = { n: k + 1, meetingId: i.meetingId, title: i.title, startedAt: i.startedAt, atMs: i.atMs, excerpt: i.text }
          const range = i.transcriptRange, meeting = p.store.meeting(i.meetingId)
          if (range && meeting) source.transcript = {
            speakers: p.store.speakerOrder(i.meetingId),
            lines: p.store.segments(i.meetingId).filter(s => s.startMs >= range.startMs && s.startMs < range.endMs)
              .map(({ text, track, speaker, startMs }) => ({ text: respell(text, meetingWords(meeting)), track, speaker, startMs })),
          }
          return source
        })
        const found = [...new Set(items.map((i) => i.meetingId))]
        turn.step = { kind: 'reading', meetings: found.length, ...(found.length === 1 ? { title: items[0].title } : {}) }
        // the sources go out at once, so citations become links as they are written
        if (!over) flush()
        if (signal.aborted) return
        const answer = await llm.chat(libraryPrompt({ items, question, history: recent, now: now(), spelling }), (t) => {
          if (signal.aborted) return
          written += t; turn.answer = written; later()
        }, { maxTokens: ANSWER_TOKENS })
        if (!signal.aborted) completed = answer
      } finally {
        // stopped by the queue alone (a recording needs the room): it starts over later, so what was written goes
        if (stop.aborted && !ac.signal.aborted) { written = ''; completed = undefined; turn.answer = ''; turn.sources = []; turn.status = 'waiting'; turn.step = undefined; later() }
      }
    }, 'chat')
    // a stop ends it at once, even while it still waits in the queue (the job then does nothing when its turn comes)
    const stopped = new Promise<void>((r) => ac.signal.addEventListener('abort', () => r(), { once: true }))

    const finished = (async () => {
      try {
        await Promise.race([job, stopped])
        turn.answer = single ? (completed ?? written).trim() : tidyCitations((completed ?? written).trim(), turn.sources)
        turn.status = ac.signal.aborted ? 'stopped' : 'done'
        turn.step = undefined
        const cited = new Set(citedIn(turn.answer))
        p.library.setTurn(turn.id, turn.answer, turn.status === 'stopped', turn.sources.filter((s) => cited.has(s.n)))
      } catch (e) {
        console.error('answering a question across meetings failed', e)
        turn.status = 'failed'
        p.library.deleteTurn(turn.id)
      } finally {
        over = true
        if (timer) clearTimeout(timer)
        if (running.get(cid) === ac) running.delete(cid)
        if (open.get(cid) === all) push(cid)
      }
    })()
    return { id: cid, done: finished }
  }

  const recover = () => {
    for (const turn of p.library.waitingTurns()) if (!running.has(turn.conversationId)) void ask(turn.conversationId, turn.question, {}, turn.id).done
  }
  const api = {
    list,
    view,
    ask: (id: string | null, raw: string, o: { scope?: string[] } = {}) => ask(id, raw, o),
    context(id: string, chips: import('../../shared/askContext').ContextChip[]) {
      if (running.has(id)) throw new Error('Wait for the current answer before changing context')
      p.library.setContext(id, chips); push(id); p.sendList(list())
    },
    removeContext(id: string, chip: import('../../shared/askContext').ContextChip) {
      if (running.has(id)) throw new Error('Wait for the current answer before changing context')
      p.library.removeContext(id, chip); push(id); p.sendList(list())
    },
    draft(id: string, text: string) { p.library.setDraft(id, text) },
    /**
     * A conversation about exactly one meeting opened (or its question box got focus): the meeting is read into the
     * model now, so the question only reads itself. Not while the model is missing or a recording needs the room;
     * once per meeting in WARM_AGAIN_MS (repeated opens); a meeting already read costs only a check (preload skips it).
     */
    warm(id: string) {
      const c = p.library.conversation(id)
      if (!c || p.waitsForModel() || p.waitsForMeeting() || p.warmAllowed?.() === false) return
      const single = singleOf(attachContext(c.chips, c.draftChips))
      if (!single || now() - (warmed.get(single) ?? -Infinity) < WARM_AGAIN_MS) return
      warmed.set(single, now())
      void warmMeeting(p, single).catch((e) => console.error('reading a meeting in ahead failed', e))
    },
    forgetMeeting(id: string) {
      for (const [cid, ac] of running) if (p.library.scope(p.library.conversation(cid)?.chips ?? [])?.includes(id)) ac.abort()
    },
    stop(id: string) { running.get(id)?.abort() },
    rename(id: string, raw: string) {
      const title = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!title || !p.library.conversation(id)) return
      p.library.renameConversation(id, title)
      p.sendList(list()); push(id)
    },
    remove(id: string) {
      running.get(id)?.abort(); running.delete(id); open.delete(id)
      p.library.deleteConversation(id)
      p.sendList(list())
    },
    /** Imports may bring waiting questions too; open conversations hear when the model arrives. */
    refresh() { recover(); for (const id of open.keys()) push(id) },
  }
  recover()
  return api
}
export type Conversations = ReturnType<typeof hookConversations>
