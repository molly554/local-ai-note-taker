import type { RecordingStart } from '../meeting'
import type { Meeting, Segment, Store } from '../store'
import type { NotesModel } from './model'
import type { Queue } from './queue'
import { READ_BACKLOG_MS } from './queue'
import { cutTurn, languageName, partBudget, reusable, summaryHead, summaryPrompt, SUMMARY_TOKENS, tidyNotes, transcriptHead, transcriptText, wholeBudget, type PartSummary } from './enhance'

/**
 * Reading a meeting into the notes model while it is recorded, so the notes start within seconds of stopping
 * instead of a minute later (an hour's transcript is ~22k tokens, read at ~360 a second).
 * The model keeps one sequence, and a prompt that starts like what it holds only reads the rest. Every few minutes
 * the transcript so far is read in as the start of the notes prompt (transcriptHead + its lines). A long meeting (more than one context holds) has its finished parts summarised instead, and
 * the notes reuse those summaries.
 * Only on Macs with 32 GB or more (readAheadAllowed) and while transcription keeps up: it is the lowest priority job
 * in the queue, and the first thing to go when anything else needs the model. Nothing depends on it being right:
 * a prompt that differs from what was read only reads more.
 */

/** The model and whisper together during a meeting: only with room to spare (24 GB keeps the old way) */
export const readAheadAllowed = (totalBytes: number): boolean => totalBytes >= 32 * 2 ** 30

/** read in once this much more transcript has settled */
export const READ_EVERY_MS = 3 * 60_000
/**
 * Lines that ended this long ago are settled. A line arrives up to ~35 s after it was said (a 15 s chunk, up to
 * 10 s of backlog, the 2 s hold and 6 s wait of me lines), and may land before lines already saved.
 */
export const SETTLE_MS = 60_000
/** how often a recording is looked at */
const CHECK_MS = 30_000
/** room kept in case the person's notes make the notes prompt longer at the end */
const MARGIN_TOKENS = 1500
/** what is read in one go: a few seconds of the model's time, so anything else waits at most that long */
export const STEP_CHARS = 8000

/**
 * The transcript lines (turns, as the notes prompt has them) that will not change any more: lines that ended
 * SETTLE_MS before now. The last turn is held back, as the same voice may go on. final: the meeting is over and
 * every line is in.
 */
export function stableTurns(segments: Segment[], nowMs: number, o: { final?: boolean } = {}): { lines: string[]; untilMs: number; segments: Segment[] } {
  const cutoff = o.final ? Infinity : nowMs - SETTLE_MS
  const taken: Segment[] = []
  for (const s of segments) {
    if (s.endMs > cutoff) break
    taken.push(s)
  }
  if (!taken.length) return { lines: [], untilMs: 0, segments: [] }
  const lines = transcriptText(taken).split('\n')
  if (o.final) return { lines, untilMs: taken.at(-1)!.endMs, segments: taken }
  // the segments of the last turn are left for next time
  let k = taken.length
  const who = (s: Segment) => (s.track === 'me' ? 'me' : s.speaker ?? '')
  while (k > 0 && who(taken[k - 1]) === who(taken[taken.length - 1])) k--
  return { lines: lines.slice(0, -1), untilMs: k ? taken[k - 1].endMs : 0, segments: taken.slice(0, k) }
}

/** time to read in more: this Mac has room, transcription keeps up, and 3 more minutes have settled */
export function shouldReadAhead(s: { live: boolean; backlogMs: number; untilMs: number; readMs: number; everyMs?: number }): boolean {
  return s.live && s.backlogMs <= READ_BACKLOG_MS && s.untilMs - s.readMs >= (s.everyMs ?? READ_EVERY_MS)
}

/** what is read in: the notes prompt as far as these lines */
export const readAheadText = (lines: string[]): string => transcriptHead + lines.join('\n')

/**
 * A long meeting's finished parts, as the line index each ends at (exclusive), from line `from`: a part is finished
 * once the next line would take it past maxTokens. A line bigger than a part stops it (the notes split those).
 */
export function finishedParts(lineTokens: number[], maxTokens: number, from: number): number[] {
  const ends: number[] = []
  let size = 0
  for (let i = from; i < lineTokens.length; i++) {
    const n = lineTokens[i] + 1
    if (n > maxTokens) break
    if (size + n > maxTokens) { ends.push(i); size = 0 }
    size += n
  }
  return ends
}

/**
 * Lines too big for one part (a long monologue) cut at sentences, each piece still saying who spoke, so a part, and
 * so a read, never outgrows the context. Sizes are guessed from characters (3 a token), on the safe side.
 */
export function splitLong(lines: string[], maxTokens: number): string[] {
  const guess = (s: string) => Math.ceil(s.length / 3)
  return lines.flatMap((l) => (guess(l) + 1 <= maxTokens ? [l] : cutTurn(l, maxTokens - 1, guess)))
}

/**
 * Has the model read `text`, starting from what it holds (`held`, the text it last read): only what is new, in steps
 * of about `step` characters ending at a line break, so a stop gets in between. Returns what it holds after.
 * Text the model already holds (or holds more of) is not read again: reading a shorter text would drop the rest.
 */
export async function readInSteps(held: string, text: string, read: (text: string) => Promise<void>, signal?: AbortSignal, step = STEP_CHARS): Promise<string> {
  let same = 0
  while (same < held.length && same < text.length && held[same] === text[same]) same++
  if (same === text.length) return held
  let at = same
  while (at < text.length) {
    if (signal?.aborted) break
    const cut = text.indexOf('\n', at + step)
    const end = cut === -1 ? text.length : cut
    await read(text.slice(0, end))
    // a step stopped while it waited may never have been read: count only what surely was
    if (signal?.aborted) break
    held = text.slice(0, end)
    at = end
  }
  return held
}

type Session = { startedAt: number; readMs: number; parts: PartSummary[]; counts: Map<string, number>; stopTimer?: () => void; queued?: boolean }

/** the language the summaries are written in: the meeting's own once saved, else the one heard most so far */
const languageOf = (store: Pick<Store, 'meeting'>, guess: (id: string) => string | null, id: string) => languageName(store.meeting(id)?.language ?? guess(id))

export function hookReadAhead(p: {
  store: Pick<Store, 'segments' | 'meeting'>
  queue: Queue
  model: Pick<NotesModel, 'llm'>
  /** reading ahead is allowed on this Mac (readAheadAllowed) */
  live: boolean
  /** audio waiting for transcription, in ms */
  backlogMs: () => number
  /** the language heard most so far */
  language: (id: string) => string | null
  /** the transcript is all saved, after the meeting stops */
  transcribed: (id: string) => Promise<void>
  onStart: (fn: (m: RecordingStart) => void) => unknown
  onStop: (fn: (m: Meeting) => void) => unknown
  now?: () => number
  every?: (fn: () => void, ms: number) => () => void
  /** local checks on short clips read ahead more often (default READ_EVERY_MS) */
  readEveryMs?: number
}) {
  const now = p.now ?? Date.now
  const every = p.every ?? ((fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t) })
  /** each recording's state, while it records and until its last read after it */
  const sessions = new Map<string, Session>()
  /** a long meeting's part summaries, kept for its notes (and Write again) while the app runs */
  const kept = new Map<string, PartSummary[]>()

  const job = (id: string, s: Session, final: boolean) => async (signal: AbortSignal) => {
    const { lines: stable, untilMs } = stableTurns(p.store.segments(id), now() - s.startedAt, { final })
    if (!stable.length) return
    const llm = await p.model.llm(signal)
    if (!llm.readAhead || signal.aborted) return
    const language = languageOf(p.store, p.language, id)
    const count = async (lines: string[]) => {
      const fresh = [...new Set(lines.filter((l) => !s.counts.has(l)))]
      if (fresh.length) (await llm.count(fresh)).forEach((n, i) => s.counts.set(fresh[i], n))
      return lines.map((l) => s.counts.get(l)!)
    }
    const total = (await count(stable)).reduce((a, b) => a + b + 1, 0)
    if (!s.parts.length && total <= (await wholeBudget(llm, language)) - MARGIN_TOKENS) {
      await llm.readAhead(readAheadText(stable), signal)
    } else {
      const max = await partBudget(llm, language)
      const lines = splitLong(stable, max)
      const tokens = await count(lines)
      // a long meeting: parts that no longer match (names settled after it) are dropped from the first one that differs
      s.parts.length = reusable(lines, s.parts).length
      let from = s.parts.reduce((n, x) => n + x.lines.length, 0)
      for (const end of finishedParts(tokens, max, from)) {
        if (signal.aborted) return
        const part = lines.slice(from, end).join('\n')
        const n = s.parts.length + 1
        // read in steps first (they can be stopped); the chat then only reads the question and writes
        await llm.readAhead(summaryHead(n) + part, signal)
        if (signal.aborted) return
        const summary = tidyNotes(await llm.chat(summaryPrompt(part, n, language), () => {}, { summary: true, maxTokens: SUMMARY_TOKENS }))
        if (signal.aborted) return
        s.parts.push({ lines: lines.slice(from, end), summary })
        from = end
      }
      await llm.readAhead(summaryHead(s.parts.length + 1) + lines.slice(from).join('\n'), signal)
    }
    if (!signal.aborted) s.readMs = untilMs
  }

  const tick = (id: string, s: Session) => {
    const { untilMs } = stableTurns(p.store.segments(id), now() - s.startedAt)
    // one still waiting or reading reads what has settled by the time it runs
    if (s.queued || !shouldReadAhead({ live: p.live, backlogMs: p.backlogMs(), untilMs, readMs: s.readMs, everyMs: p.readEveryMs })) return
    s.queued = true
    p.queue.enqueue(job(id, s, false), 'readahead', id).catch((e) => console.error('reading ahead failed', id, e)).finally(() => { s.queued = false })
  }

  p.onStart((m) => {
    if (!p.live) return
    // a new recording (of this id too) starts afresh
    sessions.get(m.id)?.stopTimer?.()
    kept.delete(m.id)
    const s: Session = { startedAt: m.resume ? m.resume.startedAt - m.resume.startMs : m.startedAt, readMs: 0, parts: [], counts: new Map() }
    sessions.set(m.id, s)
    kept.set(m.id, s.parts)
    s.stopTimer = every(() => tick(m.id, s), CHECK_MS)
  })

  // once the transcript is all in, the rest is read; then the session goes
  p.onStop((m) => {
    const s = sessions.get(m.id)
    if (!s) return
    s.stopTimer?.(); s.stopTimer = undefined
    void p.transcribed(m.id)
      .then(() => p.queue.enqueue(job(m.id, s, true), 'readahead', m.id))
      .catch((e) => console.error('reading ahead failed', m.id, e))
      .finally(() => { if (sessions.get(m.id) === s) sessions.delete(m.id) })
  })

  return {
    /** the parts of a long meeting summarised while it was recorded (none for one that fits whole) */
    parts: (id: string): PartSummary[] => kept.get(id) ?? [],
  }
}
export type ReadAhead = ReturnType<typeof hookReadAhead>
