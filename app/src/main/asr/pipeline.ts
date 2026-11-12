import type { Segment } from '../store'
import type { Track, TranscribeWarn } from '../capture'
import type { TranscriptPartial } from '../../shared/types'
import { afterFinal, joinWords, replaceWords, wordsOf, type Heard, type LiveWord } from '../../shared/liveWords'
import { chunker, type Chunk } from './chunker'
import { echoConfidence, isVerbatimCopy, type EchoCheck } from './echo'
import { EchoDetector } from './echoDetect'
import type { Line, Transcribe } from './transcribe'

type Out = Omit<Segment, 'id'>

/** If their lines are still being worked on, or they are mid-sentence, a held me line waits for them, but not longer than this */
const EXTRA_WAIT_MS = 6000

/** Audio waiting for whisper, per track. Past this the oldest chunks are dropped, so a stuck server can't grow memory without end. */
export const MAX_QUEUED_MS = 3 * 60_000

/**
 * One meeting's live transcription: audio in, saved and shown lines out.
 * Each track has its own queue with one request in flight. A `me` line waits `holdMs` before it is saved,
 * so a copy of the other side's voice picked up by the mic can be dropped once their line has arrived.
 */
export function createPipeline(p: {
  meetingId: string
  transcribe: Transcribe
  save: (segs: Out[]) => void
  emit: (seg: Out) => void
  /** a quick reading of a chunk still being spoken (text empty when it is over); none: no partials are asked for */
  emitPartial?: (part: TranscriptPartial) => void
  holdMs?: number
  extraWaitMs?: number
  maxQueuedMs?: number
  /** for tests: stand in for the echo detector */
  echoForTests?: EchoCheck
  /** trouble worth telling the person about; each kind is reported once */
  onWarn?: (kind: Exclude<TranscribeWarn, 'no-speech-model'>) => void
  /** who said a line of the other side, as the call app showed it (callNames); null: Them */
  nameOf?: (startMs: number, endMs: number) => string | null
  /** the meeting's spellings of names and companies (vocab.ts respell) */
  respell?: (text: string) => string
}) {
  const hold = p.holdMs ?? 2000
  const extraWait = p.extraWaitMs ?? EXTRA_WAIT_MS
  const maxQueued = ((p.maxQueuedMs ?? MAX_QUEUED_MS) * 16)
  const waiting: Record<Track, Chunk[]> = { me: [], them: [] }
  const running: Record<Track, boolean> = { me: false, them: false }
  const queued = (t: Track) => waiting[t].length + (running[t] ? 1 : 0)
  const dropped: Array<{ track: Track; startMs: number; endMs: number }> = []
  const warned = new Set<string>()
  const warn = (k: 'transcribe-failed' | 'falling-behind') => { if (!warned.has(k)) { warned.add(k); try { p.onWarn?.(k) } catch (e) { console.error('warning failed', e) } } }
  let idle: Array<() => void> = []
  const them: Line[] = []
  /** is their voice reaching the mic in this meeting (no headphones)? only then are echo lines hidden */
  const echo = new EchoDetector()
  const echoCheck = (): EchoCheck => p.echoForTests ?? { echo: echo.present(), correlatedAt: (ms) => echo.correlatedAt(ms), over: (a, b) => echo.over(a, b) }
  let held: Array<{ line: Line; readyAt: number; chunkStartMs: number; chunkEndMs: number }> = []
  let timer: NodeJS.Timeout | undefined
  let echoDropped = 0
  let closed = false
  /** wall clock minus meeting time, from the newest audio: how long after it was said a line shows */
  let wallOffset = Date.now()
  const delays: Array<{ track: Track; partial: boolean; ms: number }> = []
  const timing = (track: Track, partial: boolean, audioEndMs: number) => {
    const ms = Date.now() - (wallOffset + audioEndMs)
    delays.push({ track, partial, ms })
    console.log(`TIMING asr ${partial ? 'partial' : 'final'} ${track}: shown ${ms} ms after the speech ended`)
  }
  /**
   * The live words of each track (shared/liveWords.ts): every quick reading replaces the words of the stretch it reads,
   * and each final takes away the words it stands for. One message per track says what is left, so a reading that
   * starts somewhere else never shows next to an older one, and words after a final stay on screen.
   */
  const live: Record<Track, LiveWord[]> = { me: [], them: [] }
  /** the finals given out lately per track: a reading that starts before them must not bring their words back */
  const recent: Record<Track, Array<{ endMs: number; text: string }>> = { me: [], them: [] }
  const shownText: Record<Track, string> = { me: '', them: '' }
  const partOf = (track: Track): TranscriptPartial => ({ meetingId: p.meetingId, track, startMs: live[track][0]?.startMs ?? 0, text: joinWords(live[track]), words: live[track] })
  const tell = (track: Track) => {
    const part = partOf(track)
    if (part.text === shownText[track]) return
    shownText[track] = part.text
    try { p.emitPartial?.(part) } catch (e) { console.error('sending a partial failed', e) }
  }
  /** a reading's words, less what the finals since its start already say */
  const unsaid = (track: Track, ws: LiveWord[]) => recent[track].reduce((left, f) => afterFinal(left, f), ws)
  const read = (track: Track, ws: LiveWord[], drop: (w: LiveWord) => boolean) => { live[track] = replaceWords(live[track], unsaid(track, ws), drop); tell(track) }
  /** a final (or a stretch that will never get one: dropped, failed, nothing heard) up to endMs */
  const settle = (track: Track, endMs: number, text = '') => {
    const f = { endMs, text }
    recent[track] = [...recent[track], f].slice(-8)
    live[track] = afterFinal(live[track], f)
    tell(track)
  }
  const clearLive = (track: Track) => { live[track] = []; tell(track) }
  const midOf = (w: LiveWord) => (w.startMs + w.endMs) / 2

  const spell = (t: string) => { try { return p.respell?.(t) ?? t } catch { return t } }
  // the mic is always the person using Yogurt
  const speakerOf = (l: Line) => { if (l.track === 'me') return 'me'; try { return p.nameOf?.(l.startMs, l.endMs) ?? null } catch { return null } }
  const out = (l: Line, hidden = false): Out => ({ meetingId: p.meetingId, track: l.track, startMs: l.startMs, endMs: l.endMs, text: spell(l.text), speaker: speakerOf(l), ...(hidden ? { hidden: true } : {}) })
  const give = (lines: Line[]) => {
    if (!lines.length) return
    const segs = lines.map((l) => out(l))
    try { p.save(segs) } catch (e) { console.error('saving transcript lines failed', e) }
    for (const s of segs) { try { p.emit(s) } catch (e) { console.error('sending a transcript line failed', e) } }
    for (const s of segs) timing(s.track, false, s.endMs)
  }
  /** echo lines are kept too, hidden: out of the transcript and search, there to be shown again */
  const keepHidden = (lines: Array<{ line: Line; confidence: false | 'high' | 'uncertain' }>) => {
    if (!lines.length) return
    try { p.save(lines.map(({ line, confidence }) => ({ ...out(line, true), ...(confidence === 'high' ? { echoConfident: true } : {}) }))) } catch (e) { console.error('saving hidden lines failed', e) }
  }

  /** me lines whose hold is over (all of them when forced) are checked against what them said, then given out */
  const release = (force: boolean) => {
    const now = Date.now()
    // their line may still be on its way, or they are mid-sentence (the chunk not cut yet): the echo check needs it
    const waitingOnThem = queued('them') > 0 || cut.isOpen('them')
    const due = held.filter((h) => force || (now >= h.readyAt && (!waitingOnThem || now >= h.readyAt + extraWait)))
    if (!due.length) return
    held = held.filter((h) => !due.includes(h))
    const mine = due.map((h) => h.line)
    for (const m of mine) if (isVerbatimCopy(m, them)) echo.noteVerbatim()
    const check = echoCheck()
    const matches = mine.map(line => ({ line, confidence: echoConfidence(line, them, check) }))
    const kept = matches.filter(m => !m.confidence).map(m => m.line)
    echoDropped += mine.length - kept.length
    give(kept)
    keepHidden(matches.filter(m => m.confidence))
    // the chunks' live words go once their lines are shown, kept or hidden: their lines are decided
    for (const h of due) settle('me', h.chunkEndMs, h.line.text)
    if (!held.length && timer) { clearInterval(timer); timer = undefined }
  }

  const onLines = (track: Track, lines: Line[], chunkStartMs: number, chunkEndMs: number) => {
    if (track === 'them') { them.push(...lines); give(lines); settle('them', chunkEndMs, lines.map((l) => l.text).join(' ')); return }
    const readyAt = Date.now() + hold
    if (!lines.length) settle('me', chunkEndMs)
    for (const line of lines) held.push({ line, readyAt, chunkStartMs, chunkEndMs })
    if (held.length && !timer && !closed) timer = setInterval(() => release(false), 200)
  }

  const pump = (t: Track) => {
    if (running[t]) return
    const c = waiting[t].shift()
    if (!c) { if (!queued('me') && !queued('them')) { const w = idle; idle = []; w.forEach((f) => f()) } return }
    running[t] = true
    const chunkEnd = c.startMs + c.samples.length / 16
    p.transcribe(c)
      .then((lines) => onLines(t, lines, c.startMs, chunkEnd))
      // its quick reading goes too: nothing final will replace it
      .catch((e) => { console.error(`transcribing a ${t} chunk failed`, e); warn('transcribe-failed'); settle(t, chunkEnd) })
      .finally(() => { running[t] = false; pump(t) })
  }

  const queue = (c: Chunk) => {
    const q = waiting[c.track]
    q.push(c)
    let size = q.reduce((n, x) => n + x.samples.length, 0)
    while (size > maxQueued && q.length) {
      const old = q.shift()!
      size -= old.samples.length
      dropped.push({ track: old.track, startMs: old.startMs, endMs: Math.round(old.startMs + old.samples.length / 16) })
      settle(old.track, old.startMs + old.samples.length / 16)
      warn('falling-behind')
    }
    pump(c.track)
  }

  /** whisper's own quick readings, per track; off on a track where Apple's speech gives the live words */
  const quickReads: Record<Track, boolean> = { me: !!p.emitPartial, them: !!p.emitPartial }
  /** a quick reading slower than this means the server is loaded: the next one is skipped */
  const SLOW_PARTIAL_MS = 800
  let lastPartialMs = 0
  /** at most one quick reading per this much of a track's audio: the pace the slow-reading skip ended up at anyway */
  const PARTIAL_GAP_MS = 1600
  const lastPartialEnd: Record<Track, number> = { me: -Infinity, them: -Infinity }
  /**
   * A chunk still being spoken: read it quickly, but never in the way of a final on either track (finals always come
   * first), and not right after a slow reading. Its words replace those of the same stretch read before.
   */
  const partial = (c: Chunk) => {
    const t = c.track
    if (!quickReads[t] || !p.emitPartial || closed || running.me || running.them || waiting.me.length || waiting.them.length || lastPartialMs > SLOW_PARTIAL_MS) { if (lastPartialMs > SLOW_PARTIAL_MS) lastPartialMs = 0; return }
    const end = c.startMs + c.samples.length / 16
    if (end > lastPartialEnd[t] && end - lastPartialEnd[t] < PARTIAL_GAP_MS) return
    lastPartialEnd[t] = end
    running[t] = true
    const t0 = Date.now()
    p.transcribe(c, { partial: true })
      // the reading covers the open chunk from its start: earlier chunks' words, still waiting for their finals, stay
      .then((lines) => { if (!closed) { read(t, lines.flatMap((l) => wordsOf(l)), (w) => midOf(w) >= c.startMs); if (lines.length) timing(t, true, c.startMs + c.samples.length / 16) } })
      .catch((e) => console.warn(`a quick reading of a ${t} chunk failed`, e))
      .finally(() => { lastPartialMs = Date.now() - t0; running[t] = false; pump(t) })
  }
  const cut = chunker(queue, p.emitPartial ? partial : undefined)
  let finishing: Promise<void> | undefined

  return {
    /** Reopening a transcript uses the same current words as its live updates. */
    partials: () => (['me', 'them'] as const).map(partOf),
    push(track: Track, ms: number, samples: Float32Array) {
      if (closed) return
      wallOffset = Date.now() - (ms + samples.length / 16)
      echo.push(track, ms, samples)
      cut.push(track, ms, samples)
    },
    /** the meeting is over: what is left is transcribed, held lines are checked and saved now */
    finish(): Promise<void> {
      finishing ??= (async () => {
        cut.flush()
        await new Promise<void>((r) => { if (!queued('me') && !queued('them')) r(); else idle.push(r) })
        closed = true
        release(true)
        clearLive('me'); clearLive('them')
        if (timer) { clearInterval(timer); timer = undefined }
      })()
      return finishing
    },
    /**
     * live words from somewhere else (Apple's speech): shown like a quick reading until whisper's line lands. Not the mic's
     * while the other side is mid-sentence: without headphones that is their voice from the speakers, shown twice.
     */
    speechPartial(track: Track, r: Heard & { final: boolean }) {
      if (closed) return
      // what the mic hears while they talk is likely their voice from the speakers: not taken in, and what it said before stays
      if (track === 'me' && cut.isOpen('them')) return
      // Apple has one volatile reading at a time, from the end of its last final; a final gives each word's time.
      // Either way its last volatile words are read again, whatever start it gave them.
      const ws = wordsOf(r)
      read(track, ws, (w) => !!w.rough || (r.final ? midOf(w) >= r.startMs && midOf(w) <= r.endMs : midOf(w) >= r.startMs))
    },
    /** finished lines from somewhere else (Apple's speech, where it is trusted for the saved transcript): held and checked like whisper's */
    speechLines(track: Track, lines: Line[]) { if (closed) return; const at = lines[0]?.startMs ?? 0, end = lines.at(-1)?.endMs ?? at; onLines(track, lines, at, end) },
    /**
     * whisper's quick readings on or off, for one track or both: off on a track where Apple's speech gives the live words.
     * Switching clears what is shown on that track (Apple's words when whisper takes over, and the other way round).
     */
    setQuickReads(on: boolean, track?: Track) {
      for (const t of track ? [track] : (['me', 'them'] as const)) { quickReads[t] = on && !!p.emitPartial; clearLive(t) }
    },
    /** someone is mid-sentence on a track (a chunk is being collected) */
    talking: (track: Track) => cut.isOpen(track),
    /** audio waiting for whisper on the busiest track (not counting the chunk being worked on), in ms */
    backlogMs: () => Math.max(...(['me', 'them'] as const).map((t) => waiting[t].reduce((n, c) => n + c.samples.length, 0) / 16)),
    busy: () => !finishing || queued('me') + queued('them') + held.length > 0,
    stats: () => ({ echoDropped, dropped: [...dropped], delays: [...delays] }),
    /** echo was heard in this meeting (their voice on the mic): the sweep after it may hide lines; whether the mic echoed at a moment; what a line's own audio says */
    echoPresent: () => echoCheck().echo ?? false,
    echoAt: (ms: number) => echoCheck().correlatedAt?.(ms) ?? true,
    echoOver: (startMs: number, endMs: number) => echoCheck().over?.(startMs, endMs),
  }
}
export type Pipeline = ReturnType<typeof createPipeline>
