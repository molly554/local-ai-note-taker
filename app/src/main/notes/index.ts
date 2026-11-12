import { attendeeMembership as stamp } from '../../shared/people'
import type { Meeting, Store } from '../store'
import type { NotesModel } from './model'
import type { NoteSaveResult, NoteSide, NoteStatus, NoteView } from '../../shared/types'
import { enhance, type Llm, type PartSummary } from './enhance'
import { meetingWords } from '../vocab'
import type { Queue } from './queue'

/** The notes wait for the transcript and the names from the call, but never longer than this for the names */
export const NAMES_WAIT_MS = 60_000
/** people changed after the notes were written: they are written again once no more changes came for this long */
export const PEOPLE_REWRITE_MS = 3000
/** Reject oversized notes without silently discarding any accepted editor text. */
export const NOTES_MAX = 2_000_000
/** the draft goes to the window at most this often while it is written */
const DRAFT_EVERY_MS = 50

/**
 * Enhanced notes for each meeting: written after it stops (once its transcript and the names from the call are in), through
 * the one model queue, streamed to the window as they are written, then saved. "Write again" goes the same way.
 */
export function hookNotes(p: {
  store: Pick<Store, 'meeting' | 'notes' | 'setNotes' | 'writtenWith' | 'setWrittenWith' | 'segments' | 'updateMeeting' | 'unenhancedMeetings'>
  queue: Queue
  model: Pick<NotesModel, 'llm'> & Partial<Pick<NotesModel, 'needsLoad'>>
  /** Windows and Linux: say when the notes wait for the model to load (a Mac shows what it always did) */
  showLoading?: boolean
  /** the recording's files and transcript are final */
  transcribed: (id: string) => Promise<void>
  /** the names from the call are on its lines (callNames) */
  named?: (id: string) => Promise<void>
  /** the language most of the meeting was in, when the transcription knows it */
  language: (id: string) => string | null
  /** the language picked for notes in Settings; null (or left out): each meeting's own */
  notesLanguage?: () => string | null
  onStop: (fn: (m: Meeting) => void) => unknown
  /** a meeting's notes changed: status, draft or saved text */
  send: (v: NoteView) => void
  /** the meeting's own row changed (it is done) */
  changed: (id: string) => void
  summarized?: (id: string) => void
  namesWaitMs?: number
  /** a long meeting's parts summarised while it was recorded (readAhead.ts) */
  earlier?: (id: string) => PartSummary[]
  peopleRewriteMs?: number
  /** the person's own name, so the invite's other person is known */
  me?: () => string
}) {
  const resuming = new Map<string, object>()
  const live = new Map<string, { status: NoteStatus; draft: string; part?: { part: number; of: number }; step?: 'loading' }>()
  /** a rewrite for new people, waiting for the changes to settle */
  const rewriteTimers = new Map<string, NodeJS.Timeout>()
  const rewriting = new Set<string>()
  /** who the notes had before a rewrite swapped new ones in: put back if the open note kept its own edits instead */
  const writingPeople = new Map<string, { stamp: string }>()
  const stampBefore = new Map<string, string | null>()
  /** Latest editor revisions. Failed text survives route changes and renderer recreation, until saved or explicitly discarded. */
  const edits = new Map<string, Partial<Record<NoteSide, NoteSaveResult & { text?: string }>>>()
  const currentNotes = (id: string) => {
    const saved = p.store.notes(id), pending = edits.get(id)
    return { ...saved, mine: pending?.mine?.text ?? saved.mine, enhanced: pending?.enhanced?.text ?? saved.enhanced,
      edited: pending?.enhanced?.text !== undefined || saved.edited }
  }

  /** the notes were written with other people than the meeting has now (not known for notes older than this) */
  const peopleChanged = (id: string, written: boolean) => {
    const was = p.store.writtenWith(id)
    return written && was != null && was !== stamp(p.store.meeting(id)?.attendees ?? [])
  }

  /** out of date, unless they are being written again on their own right now (then no hint) */
  const view = (id: string): NoteView => {
    const n = currentNotes(id)
    const l = live.get(id)
    const saved = edits.get(id)
    const saves = saved && Object.fromEntries(Object.entries(saved).map(([side, edit]) => [side, { revision: edit.revision, status: edit.status, ...(edit.reason ? { reason: edit.reason } : {}) }]))
    return { meetingId: id, mine: n.mine, enhanced: n.enhanced, edited: n.edited, status: l?.status ?? (n.enhanced != null ? 'done' : 'idle'), draft: l?.draft ?? '', peopleChanged: peopleChanged(id, n.enhanced != null) && !rewriteTimers.has(id) && !rewriting.has(id), ...(l?.part ? { part: l.part } : {}), ...(l?.step ? { step: l.step } : {}), ...(saves ? { saves } : {}) }
  }
  const set = (id: string, status: NoteStatus, draft = '', part?: { part: number; of: number }, step?: 'loading') => { live.set(id, { status, draft, part, step }); p.send(view(id)) }

  const saveEdit = (id: string, side: NoteSide, md: string, revision?: number): NoteSaveResult => {
    const sides = edits.get(id) ?? {}, previous = sides[side]
    const rev = revision ?? (previous?.revision ?? 0) + 1
    // A delayed request/acknowledgement cannot replace a newer edit.
    if (previous && rev < previous.revision) return { revision: rev, status: 'failed', retained: false }
    if (previous?.revision === rev && previous.status === 'saved') return { revision: rev, status: 'saved' }
    const edit: NoteSaveResult & { text?: string } = { revision: rev, status: 'failed', text: md }
    sides[side] = edit
    edits.set(id, sides)
    try {
      if (!p.store.meeting(id)) { delete sides[side]; if (!Object.keys(sides).length) edits.delete(id); return { revision: rev, status: 'failed', retained: false } }
      // A draft arriving during generation is retained rather than silently ignored.
      if (md.length > NOTES_MAX) edit.reason = 'too-long'
      else if (side !== 'enhanced' || live.get(id)?.status !== 'writing') {
        p.store.setNotes(id, side === 'mine' ? { mine: md } : { enhanced: md, edited: true })
        edit.status = 'saved'; delete edit.text
      }
    } catch (e) { console.error('note edit was not saved; kept for retry', id, side, e) }
    try { p.send(view(id)) } catch (e) { console.error('could not refresh the note after saving', id, e) }
    return { revision: rev, status: edit.status, ...(edit.status === 'failed' ? { retained: true, ...(edit.reason ? { reason: edit.reason } : {}) } : {}) }
  }
  const retryDrafts = (onlyId?: string): boolean => {
    let saved = true
    for (const [id, sides] of edits) {
      if (onlyId && id !== onlyId) continue
      for (const side of ['mine', 'enhanced'] as const) {
        const edit = sides[side]
        if (edit?.text !== undefined && saveEdit(id, side, edit.text, edit.revision).status !== 'saved') saved = false
      }
    }
    return saved
  }

  /**
   * quiet: written again for new people, out of sight. The notes on screen stay as they are until the new ones are done,
   * then change all at once (never if the person edited them meanwhile).
   */
  const write = async (id: string, signal: AbortSignal, quiet = false) => {
    const m = p.store.meeting(id)
    if (!m || m.state === 'recording' || resuming.has(id)) return
    const was = currentNotes(id)
    const mine = was.mine
    const segments = p.store.segments(id)
    // nothing said and nothing typed: there is nothing to write up
    if (!segments.length && !mine.trim()) { if (!quiet) finish(m, 'empty'); return }
    // still "getting ready" while the model loads: "writing" comes with the first words (or a long meeting's first part)
    // the people the prompt is built with: a change while writing then still marks these notes as out of date
    const used = { stamp: stamp(m.attendees) }
    writingPeople.set(id, used)
    const language = p.notesLanguage?.() ?? m.language ?? p.language(id)
    let draft = '', last = 0, timer: NodeJS.Timeout | undefined
    // blank lines would show as empty paragraphs while streaming, then vanish once tidied: never shown
    const flush = () => { timer = undefined; last = Date.now(); if (!signal.aborted) set(id, 'writing', draft.replace(/\n[ \t]*(?=\n)/g, '')) }
    try {
      console.info('NOTES', `writing the notes of ${id}`)
      if (!quiet && p.showLoading && p.model.needsLoad?.()) set(id, 'waiting', '', undefined, 'loading')
      const llm = await p.model.llm(signal)
      if (!quiet && live.get(id)?.step) set(id, 'waiting')
      // a generic title (or one made from earlier notes) gets one from these notes; theirs or the calendar's never
      const retitle = (x: Meeting) => x.titleSource === 'generic' || x.titleSource === 'auto'
      let askTitle: ((llm: Llm) => Promise<string>) | undefined
      const md = await enhance({ meeting: m, mine, segments, language, me: p.me?.(), words: meetingWords(m), ...(retitle(m) ? { titleLater: (ask) => { askTitle = ask } } : {}) }, llm, (t) => {
        if (quiet) return
        draft += t
        if (timer) return
        const wait = DRAFT_EVERY_MS - (Date.now() - last)
        if (wait <= 0) flush(); else timer = setTimeout(flush, wait)
      }, (part, of) => { if (!signal.aborted && !quiet) set(id, 'writing', '', { part, of }) }, p.earlier?.(id))
      if (timer) clearTimeout(timer)
      if (quiet) {
        // stopped for a recording: the queue runs it again. Edited (or written again by hand) meanwhile: theirs stands
        const now = currentNotes(id)
        if (signal.aborted || now.edited || now.enhanced !== was.enhanced || live.has(id)) return
        stampBefore.set(id, p.store.writtenWith(id))
        p.store.setNotes(id, { enhanced: md, edited: false })
        p.store.setWrittenWith(id, used.stamp)
        p.send({ ...view(id), rewrittenFrom: was.enhanced ?? '' })
        queueTitle(id, askTitle)
        p.summarized?.(id)
        return
      }
      if (signal.aborted) { set(id, 'waiting'); return }
      // the person's own notes stay as they typed them, even if they typed on while this was written
      p.store.setNotes(id, { enhanced: md, edited: false })
      p.store.setWrittenWith(id, used.stamp)
      finish(m, 'done')
      queueTitle(id, askTitle)
      p.summarized?.(id)
    } catch (e) {
      if (timer) clearTimeout(timer)
      if (quiet) { if (!signal.aborted) console.error('writing the notes again for new people failed', id, e); throw e }
      // stopped for a recording: it runs again after
      if (signal.aborted) { set(id, 'waiting'); throw e }
      console.error('writing the notes failed', id, e)
      set(id, 'failed')
      throw e
    } finally { if (writingPeople.get(id) === used) writingPeople.delete(id) }
  }

  /**
   * A title from the notes just saved, for a meeting whose title is generic (or was made from earlier notes): a job of
   * its own, so one stopped for a recording asks again later and never writes the notes again.
   */
  const queueTitle = (id: string, ask?: (llm: Llm) => Promise<string>) => {
    if (!ask) return
    void p.queue.enqueue(async (signal) => {
      const t = await ask(await p.model.llm(signal))
      // renamed while it was asked for: theirs stands
      const now = p.store.meeting(id)
      if (!t || signal.aborted || !(now?.titleSource === 'generic' || now?.titleSource === 'auto')) return
      p.store.updateMeeting(id, { title: t, titleSource: 'auto' })
      p.changed(id)
    }, 'enhance', id).catch(() => {})
  }

  /** wait for something, but never longer than this */
  const upTo = async (wait: Promise<void>, ms: number) => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([wait.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
    clearTimeout(timer)
  }

  const finish = (m: Meeting, status: NoteStatus) => {
    if (m.state === 'stopped') { p.store.updateMeeting(m.id, { state: 'done' }); p.changed(m.id) }
    live.delete(m.id)
    if (status === 'empty') live.set(m.id, { status, draft: '' })
    p.send(view(m.id))
  }

  const queueWrite = (id: string) => {
    console.info('NOTES', `queued the notes of ${id}`)
    set(id, 'waiting')
    return p.queue.enqueue((signal) => write(id, signal), 'enhance', id).catch(() => {})
  }

  /** each meeting's notes after it stopped, until they are written */
  const afterStop = new Map<string, Promise<void>>()
  p.onStop((m) => {
    set(m.id, 'waiting')
    const done = (async () => {
      await p.transcribed(m.id)
      // the names from the call are quick; a stuck pass never holds the notes back for long
      if (p.named) await upTo(p.named(m.id), p.namesWaitMs ?? NAMES_WAIT_MS)
      if (!resuming.has(m.id)) await queueWrite(m.id)
    })().catch((e) => console.error('notes after the meeting failed', e)).finally(() => afterStop.delete(m.id))
    afterStop.set(m.id, done)
  })

  const notes = {
    view,
    /** Hold obsolete analysis while a finished note is prepared for another recording session. */
    suspendForResume(id: string) {
      const token = {}, restore = afterStop.has(id) || live.get(id)?.status === 'waiting' || live.get(id)?.status === 'writing' || rewriteTimers.has(id) || rewriting.has(id)
      resuming.set(id, token)
      clearTimeout(rewriteTimers.get(id)); rewriteTimers.delete(id)
      const settled = (async () => {
        await p.queue.cancelAnalysis(id)
        await afterStop.get(id)
        // Final read-ahead may have queued after transcription settled.
        await p.queue.cancelAnalysis(id)
        if (resuming.get(id) === token) { live.delete(id); p.send(view(id)) }
      })()
      return { settled, release(restart: boolean) {
        if (resuming.get(id) !== token) return
        resuming.delete(id)
        if (restart && restore && !afterStop.has(id)) { live.delete(id); void queueWrite(id) }
      } }
    },
    /** the lines changed (echo lines shown again): the window hears the notes again */
    refresh(id: string) { p.send(view(id)) },
    /** resolves when the notes after the meeting are written (or failed); undefined when none are on the way */
    renamed(id: string, before: Meeting['attendees'], after: Meeting['attendees']) {
      const used = writingPeople.get(id)
      if (used?.stamp === stamp(before)) used.stamp = stamp(after)
    },
    written: (id: string): Promise<void> | undefined => afterStop.get(id),
    /**
     * People added or removed after the notes were written (by hand, or seen in the call): unedited notes are written
     * again on their own, once the changes settle, out of sight. Edited notes keep the "People changed" hint instead.
     */
    applyPeople(id: string) {
      clearTimeout(rewriteTimers.get(id)); rewriteTimers.delete(id)
      const due = () => { const n = currentNotes(id); return !resuming.has(id) && p.store.meeting(id)?.state !== 'recording' && n.enhanced != null && !n.edited && !live.has(id) && !rewriting.has(id) && peopleChanged(id, true) }
      if (!due()) { p.send(view(id)); return }
      rewriteTimers.set(id, setTimeout(() => {
        rewriteTimers.delete(id)
        // edited meanwhile: the hint shows instead
        if (!due()) { p.send(view(id)); return }
        rewriting.add(id)
        // people that changed while it was written get one more go
        p.queue.enqueue((signal) => write(id, signal, true), 'enhance', id).catch(() => {}).finally(() => { rewriting.delete(id); notes.applyPeople(id) })
      }, p.peopleRewriteMs ?? PEOPLE_REWRITE_MS))
      p.send(view(id))
    },
    /** the open note kept its unsaved edits over a rewrite: those were written with the old people, so the hint comes back */
    keptEdits(id: string) {
      if (!stampBefore.has(id)) return
      p.store.setWrittenWith(id, stampBefore.get(id)!)
      stampBefore.delete(id)
      p.send(view(id))
    },
    setMine: (id: string, md: string, revision?: number) => saveEdit(id, 'mine', md, revision),
    setEnhanced: (id: string, md: string, revision?: number) => saveEdit(id, 'enhanced', md, revision),
    retryDrafts,
    pendingDraftId: () => [...edits].find(([, sides]) => Object.values(sides).some((v) => v.text !== undefined))?.[0],
    forgetDrafts: (id: string) => { edits.delete(id) },
    /** "Write again": the same job, now (after anything already waiting) */
    writeAgain(id: string) {
      if (resuming.has(id) || p.store.meeting(id)?.state === 'recording') return Promise.resolve()
      if (!retryDrafts(id)) return Promise.resolve()
      const s = live.get(id)?.status
      if (s === 'waiting' || s === 'writing') return Promise.resolve()
      return queueWrite(id)
    },
    /** at launch: meetings a quit or crash left without notes get them now, one at a time */
    recover() {
      for (const m of p.store.unenhancedMeetings()) if (!live.has(m.id) && !resuming.has(m.id)) void queueWrite(m.id)
    },
  }
  return notes
}
export type Notes = ReturnType<typeof hookNotes>
