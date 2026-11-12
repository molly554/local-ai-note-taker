import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Meeting, type Store } from '../src/main/store'
import { hookNotes, NOTES_MAX } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import type { Llm } from '../src/main/notes/enhance'
import type { NoteView } from '../src/shared/types'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function setup(o: { named?: () => Promise<void>; namesWaitMs?: number; reply?: string | ((prompt: string) => string); during?: () => void; load?: Promise<void>; title?: string; recording?: () => boolean; smallMac?: boolean; showLoading?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-notes-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const m = store.createMeeting({ title: o.title ?? 'Sync', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'stopped' })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'We ship Tuesday.', speaker: 'Priya Nair' }])
  store.setNotes(m.id, { mine: '- ship tuesday' })
  let transcribed!: () => void
  const transcript = new Promise<void>((r) => { transcribed = r })
  const stops: Array<(m: Meeting) => void> = []
  const sent: NoteView[] = []
  const prompts: string[] = []
  const changed: string[] = []
  const llm: Llm = {
    contextSize: 32_000, count: async (xs) => xs.map((x) => x.length),
    chat: async (prompt, onToken) => { prompts.push(prompt); o.during?.(); const r = typeof o.reply === 'function' ? o.reply(prompt) : o.reply ?? '## Plan\n- We ship Tuesday\n## Next steps\n- **Ann:** Send it.'; onToken(r); return r },
  }
  const queue = createQueue({ recording: o.recording ?? (() => false), smallMac: o.smallMac ?? false })
  const notes = hookNotes({
    store, queue, model: { llm: async () => { await o.load; return llm }, needsLoad: () => true }, showLoading: o.showLoading,
    transcribed: () => transcript, named: o.named, namesWaitMs: o.namesWaitMs, language: () => 'spanish',
    onStop: (fn) => stops.push(fn), send: (v) => sent.push(v), changed: (id) => changed.push(id), peopleRewriteMs: 30,
  })
  return { store, m, notes, sent, prompts, changed, queue, stop: () => stops.forEach((f) => f(m)), transcribed }
}

describe('hookNotes', () => {
  it('off a Mac, a note waiting on the model to load says so; then it writes', async () => {
    let release!: () => void
    const load = new Promise<void>((resolve) => { release = resolve })
    const s = setup({ load, showLoading: true })
    s.stop(); s.transcribed()
    await vi.waitFor(() => expect(s.sent.at(-1)).toMatchObject({ status: 'waiting', step: 'loading' }))
    release(); await s.notes.written(s.m.id)
    expect(s.sent.at(-1)).toMatchObject({ status: 'done' })
    expect(s.sent.at(-1)?.step).toBeUndefined()
  })

  it('a Mac shows no loading step (as before)', async () => {
    let release!: () => void
    const load = new Promise<void>((resolve) => { release = resolve })
    const s = setup({ load })
    s.stop(); s.transcribed(); await wait(20)
    expect(s.sent.some((v) => v.step)).toBe(false)
    release(); await s.notes.written(s.m.id)
  })

  it('resume cancels obsolete generation without replacing the prior summary and next Finish writes combined notes', async () => {
    let release!: () => void
    const load = new Promise<void>((resolve) => { release = resolve })
    const s = setup({ load })
    s.store.setNotes(s.m.id, { enhanced: 'Keep the previous summary.', edited: true })
    s.stop(); s.transcribed(); await wait()
    const held = s.notes.suspendForResume(s.m.id)
    release(); await held.settled
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: 'Keep the previous summary.', mine: '- ship tuesday' })
    s.store.updateMeeting(s.m.id, { state: 'recording', attendees: [{ name: 'Ann Lee', email: 'ann@zentrik.example' }] }); held.release(false)
    await s.notes.writeAgain(s.m.id)
    expect(s.store.notes(s.m.id).enhanced).toBe('Keep the previous summary.')
    s.store.addSegments([{ meetingId: s.m.id, track: 'me', startMs: 10_000, endMs: 11_000, text: 'More decisions from the resumed session.', speaker: 'me' }])
    s.store.updateMeeting(s.m.id, { state: 'stopped' }); s.stop()
    await s.notes.written(s.m.id)
    expect(s.prompts.at(-1)).toContain('More decisions from the resumed session.')
    expect(s.prompts.at(-1)).toContain('Zentrik')
    expect(s.store.notes(s.m.id).enhanced).toContain('## Plan')
    expect(s.store.notes(s.m.id).mine).toBe('- ship tuesday')
  })

  it('retains the latest failed edit by note and side, then acknowledges only its successful retry', () => {
    const s = setup()
    const write = vi.spyOn(s.store, 'setNotes').mockImplementation(() => { throw new Error('SQLITE_FULL') })
    expect(s.notes.setMine(s.m.id, 'first edit', 1)).toEqual({ revision: 1, status: 'failed', retained: true })
    expect(s.notes.setMine(s.m.id, 'latest exact edit', 2)).toEqual({ revision: 2, status: 'failed', retained: true })
    expect(s.notes.setEnhanced(s.m.id, 'edited enhanced copy', 1)).toEqual({ revision: 1, status: 'failed', retained: true })
    expect(s.notes.view(s.m.id)).toMatchObject({ mine: 'latest exact edit', enhanced: 'edited enhanced copy', edited: true,
      saves: { mine: { revision: 2, status: 'failed' }, enhanced: { revision: 1, status: 'failed' } } })
    // A delayed older request must not replace the latest revision in main either.
    expect(s.notes.setMine(s.m.id, 'older delayed request', 1).status).toBe('failed')
    expect(s.notes.view(s.m.id).mine).toBe('latest exact edit')
    expect(s.notes.pendingDraftId()).toBe(s.m.id)
    write.mockRestore()
    expect(s.notes.retryDrafts()).toBe(true)
    expect(s.store.notes(s.m.id)).toMatchObject({ mine: 'latest exact edit', enhanced: 'edited enhanced copy', edited: true })
    expect(s.notes.pendingDraftId()).toBeUndefined()
    expect(s.notes.view(s.m.id).saves?.mine).toEqual({ revision: 2, status: 'saved' })
  })
  it('retains an oversized note in full without acknowledging a truncated save, then saves a shorter revision', () => {
    const s = setup(), original = s.store.notes(s.m.id).mine
    const full = 'x'.repeat(NOTES_MAX) + 'IMPORTANT-END-SENTINEL'
    expect(s.notes.setMine(s.m.id, full, 1)).toEqual({ revision: 1, status: 'failed', retained: true, reason: 'too-long' })
    expect(s.notes.view(s.m.id).mine).toBe(full)
    expect(s.notes.view(s.m.id).saves?.mine?.reason).toBe('too-long')
    expect(s.store.notes(s.m.id).mine).toBe(original)
    expect(s.notes.retryDrafts()).toBe(false)
    expect(s.notes.setMine(s.m.id, 'Shorter note with IMPORTANT-END-SENTINEL', 2).status).toBe('saved')
    expect(s.store.notes(s.m.id).mine).toBe('Shorter note with IMPORTANT-END-SENTINEL')
    expect(s.notes.pendingDraftId()).toBeUndefined()
  })
  it('after the transcript is in, writes the notes, marks the person\'s own line, saves them and finishes the meeting', async () => {
    const s = setup()
    s.stop()
    await wait()
    expect(s.notes.view(s.m.id).status).toBe('waiting')
    expect(s.prompts).toEqual([])
    s.transcribed(); await wait(20)
    expect(s.prompts[0]).toContain('Spanish')
    expect(s.prompts[0]).toContain('Priya Nair: We ship Tuesday.')
    expect(s.store.notes(s.m.id).enhanced).toBe('## Plan\n- <mine>We ship Tuesday</mine>\n## Next steps\n- **Ann:** Send it.')
    expect(s.notes.view(s.m.id).status).toBe('done')
    expect(s.store.meeting(s.m.id)!.state).toBe('done')
    expect(s.sent.map((v) => v.status)).toContain('writing')
  })
  it('says "writing" only once the first words come; loading the model is still getting ready', async () => {
    let loaded!: () => void
    const s = setup({ load: new Promise<void>((r) => { loaded = r }) })
    s.stop(); s.transcribed(); await wait(10)
    expect(s.notes.view(s.m.id).status).toBe('waiting')
    expect(s.sent.map((v) => v.status)).not.toContain('writing')
    loaded(); await wait(20)
    // the first view that says writing already has words in it
    expect(s.sent.find((v) => v.status === 'writing')?.draft).toContain('Plan')
    expect(s.notes.view(s.m.id).status).toBe('done')
  })
  it('waits for the names from the call before it writes, and writes with them', async () => {
    let named!: () => void
    const s = setup({ named: () => new Promise<void>((r) => { named = r }) })
    s.stop(); s.transcribed(); await wait(20)
    expect(s.prompts).toEqual([])
    s.store.setSegmentSpeakers([{ id: s.store.segments(s.m.id)[0].id, speaker: 'Ann Lee' }])
    named(); await wait(20)
    expect(s.prompts[0]).toContain('Ann Lee: We ship Tuesday.')
  })
  it('names that never come hold the notes back only so long', async () => {
    const s = setup({ named: () => new Promise(() => {}), namesWaitMs: 30 })
    s.stop(); s.transcribed()
    await wait(10)
    expect(s.prompts).toEqual([])
    await wait(60)
    expect(s.store.notes(s.m.id).enhanced).not.toBeNull()
  })
  it('edits to the enhanced notes are saved and marked as edited; writing again clears that', async () => {
    const s = setup()
    s.stop(); s.transcribed(); await wait(20)
    s.notes.setEnhanced(s.m.id, '## Mine')
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Mine', edited: true })
    await s.notes.writeAgain(s.m.id)
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Plan\n- <mine>We ship Tuesday</mine>\n## Next steps\n- **Ann:** Send it.', edited: false })
  })
  it('a failed rewrite retains the previous edited Enhanced text; a later successful retry replaces it', async () => {
    let failing = true
    const s = setup({ reply: () => { if (failing) throw new Error('model unavailable'); return '## Recovered\n- The new version.' } })
    s.notes.setEnhanced(s.m.id, '## Kept\n- My exact edited decision.')
    s.transcribed()
    await s.notes.writeAgain(s.m.id)
    expect(s.notes.view(s.m.id)).toMatchObject({ status: 'failed', enhanced: '## Kept\n- My exact edited decision.', edited: true })
    expect(s.store.notes(s.m.id).enhanced).toBe('## Kept\n- My exact edited decision.')
    failing = false
    await s.notes.writeAgain(s.m.id)
    expect(s.notes.view(s.m.id)).toMatchObject({ status: 'done', edited: false })
    expect(s.notes.view(s.m.id).enhanced).toContain('## Recovered\n- The new version.')
    expect(s.notes.view(s.m.id).enhanced).not.toContain('My exact edited decision.')
  })
  it('a first-generation failure has no previous Enhanced result and can retry', async () => {
    let failing = true
    const s = setup({ reply: () => { if (failing) throw new Error('model unavailable'); return '## Recovered\n- First successful notes.' } })
    s.transcribed()
    await s.notes.writeAgain(s.m.id)
    expect(s.notes.view(s.m.id)).toMatchObject({ status: 'failed', enhanced: null })
    failing = false
    await s.notes.writeAgain(s.m.id)
    expect(s.notes.view(s.m.id)).toMatchObject({ status: 'done' })
    expect(s.notes.view(s.m.id).enhanced).toContain('## Recovered\n- First successful notes.')
  })
  it('after a restart, Write again still writes in the meeting\'s language, saved on the meeting', async () => {
    const s = setup()
    s.store.updateMeeting(s.m.id, { language: 'spanish' })
    s.store.setNotes(s.m.id, { enhanced: '## Old' })
    // a fresh start: nothing in memory knows the language
    const prompts: string[] = []
    const notes = hookNotes({
      store: s.store, queue: createQueue({ recording: () => false, smallMac: false }),
      model: { llm: async () => ({ contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async (p) => { prompts.push(p); return '## Plan\n- **Ann:** x' } }) },
      transcribed: async () => {}, language: () => null,
      onStop: () => {}, send: () => {}, changed: () => {},
    })
    await notes.writeAgain(s.m.id)
    expect(prompts[0]).toContain('Write in Spanish')
  })
  it('at launch, writes the notes a quit left unwritten', async () => {
    const s = setup()
    s.notes.recover()
    await wait(20)
    expect(s.store.notes(s.m.id).enhanced).not.toBeNull()
  })
  it('notes edited while the rewrite was being written keep the edit', async () => {
    // eslint-disable-next-line prefer-const
    let s: ReturnType<typeof setup>
    s = setup({ during: () => { if (s.prompts.length === 2) s.notes.setEnhanced(s.m.id, '## Edited') } })
    s.stop(); s.transcribed(); await wait(20)
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Ann Lee', email: null }] })
    s.notes.applyPeople(s.m.id)
    await wait(150)
    expect(s.prompts).toHaveLength(2)
    expect(s.store.notes(s.m.id)).toMatchObject({ enhanced: '## Edited', edited: true })
  })
  it('an open note that kept its unsaved edits over the rewrite: the people still count as changed', async () => {
    const s = setup()
    s.stop(); s.transcribed(); await wait(20)
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Ann Lee', email: null }] })
    s.notes.applyPeople(s.m.id)
    await wait(150)
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
    s.notes.keptEdits(s.m.id)
    s.notes.setEnhanced(s.m.id, '## Theirs, from before')
    expect(s.notes.view(s.m.id).peopleChanged).toBe(true)
  })
  it('people that change while the rewrite is written: written once more after it', async () => {
    let s: ReturnType<typeof setup>
    const people = (...names: string[]) => s.store.updateMeeting(s.m.id, { attendees: names.map((name) => ({ name, email: null })) })
    // eslint-disable-next-line prefer-const
    s = setup({ during: () => { if (s.prompts.length === 2) { people('Ann Lee', 'Bo Park'); s.notes.applyPeople(s.m.id) } } })
    s.stop(); s.transcribed(); await wait(20)
    people('Ann Lee')
    s.notes.applyPeople(s.m.id)
    await wait(250)
    expect(s.prompts).toHaveLength(3)
    expect(s.prompts[2]).toContain('Bo Park')
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
  })
  it('people seen in the call after the notes were written (names from the call) get unedited notes written again too', async () => {
    const reply = (prompt: string) => `## Plan\n- ${prompt.includes('Cy Dao') ? 'Cy' : 'Someone'} ships Tuesday\n## Next steps\n- **You:** Ship`
    const s = setup({ reply })
    s.stop(); s.transcribed(); await wait(20)
    // what callNames does after the meeting: the attendees grow, then the notes hear of it
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Cy Dao', email: null }] })
    s.notes.applyPeople(s.m.id)
    await wait(150)
    expect(s.store.notes(s.m.id).enhanced).toContain('Cy ships')
  })
  it('people added or removed after the notes were written: unedited notes are written again with them', async () => {
    const reply = (prompt: string) => `## Plan\n- ${prompt.includes('Maya Chen') ? 'Maya' : 'Someone'} ships Tuesday\n## Next steps\n- **You:** Ship`
    const s = setup({ reply })
    s.stop(); s.transcribed(); await wait(20)
    expect(s.store.notes(s.m.id).enhanced).toContain('Someone ships')
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Maya Chen', email: null }] })
    s.notes.applyPeople(s.m.id)
    // being written again on their own: no "write again?" hint meanwhile
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
    expect(s.sent.at(-1)?.peopleChanged).toBe(false)
    await wait(150)
    expect(s.prompts).toHaveLength(2)
    expect(s.store.notes(s.m.id).enhanced).toContain('Maya ships')
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
  })
  it('people changed on edited notes: nothing is written, the hint shows', async () => {
    const s = setup()
    s.stop(); s.transcribed(); await wait(20)
    s.notes.setEnhanced(s.m.id, '## Mine now')
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Maya Chen', email: null }] })
    s.notes.applyPeople(s.m.id)
    await wait(120)
    expect(s.prompts).toHaveLength(1)
    expect(s.notes.view(s.m.id).peopleChanged).toBe(true)
  })
  it('notes written before Yogurt kept who was there are not marked out of date for their attendees', async () => {
    const s = setup()
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'Ann Lee', email: null }] })
    s.store.setNotes(s.m.id, { enhanced: '## Old' })
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
  })
  it('the same people again: nothing is written', async () => {
    const s = setup()
    s.stop(); s.transcribed(); await wait(20)
    s.notes.applyPeople(s.m.id)
    await wait(80)
    expect(s.prompts).toHaveLength(1)
  })
  it('written() resolves once the notes after the meeting are done', async () => {
    const s = setup()
    s.stop()
    let done = false
    void s.notes.written(s.m.id)?.then(() => { done = true })
    await wait()
    expect(done).toBe(false)
    s.transcribed(); await wait(20)
    expect(done).toBe(true)
  })
})

describe('a title from the notes', () => {
  const reply = (prompt: string) => (/Now give this meeting a title/.test(prompt) ? '"Pricing with Dana"' : '## Purpose\n- Talk pricing\n## Next steps\n- **Ann:** Send it.')
  it('a generic title is replaced once the notes are written, and the windows hear of it', async () => {
    const s = setup({ title: 'Zoom call', reply })
    s.stop(); s.transcribed(); await wait(30)
    expect(s.store.meeting(s.m.id)).toMatchObject({ title: 'Pricing with Dana', titleSource: 'auto' })
    expect(s.changed).toContain(s.m.id)
    expect(s.store.notes(s.m.id).enhanced).not.toContain('Pricing with Dana')
  })
  it('the title never holds the notes back: they are saved and done before it is asked for', async () => {
    let s!: ReturnType<typeof setup>
    const seen: Array<string | null> = []
    s = setup({ title: 'Zoom call', reply: (p) => { if (/Now give this meeting a title/.test(p)) seen.push(s.notes.view(s.m.id).status, s.store.notes(s.m.id).enhanced); return reply(p) } })
    s.stop(); s.transcribed(); await wait(30)
    expect(seen[0]).toBe('done')
    expect(seen[1]).toContain('## Purpose')
  })
  it('a title they typed, or one from the calendar, is never touched, and no title is asked for', async () => {
    for (const source of ['user', 'calendar'] as const) {
      const s = setup({ title: 'Zoom call', reply })
      s.store.updateMeeting(s.m.id, { titleSource: source })
      s.stop(); s.transcribed(); await wait(30)
      expect(s.store.meeting(s.m.id)!.title).toBe('Zoom call')
      expect(s.prompts.some((p) => /Now give this meeting a title/.test(p))).toBe(false)
    }
  })
  it('renamed while the notes were written: theirs stands', async () => {
    let s!: ReturnType<typeof setup>
    s = setup({ title: 'Zoom call', reply: (p) => { if (/Now give this meeting a title/.test(p)) s.store.updateMeeting(s.m.id, { title: 'Mine', titleSource: 'user' }); return reply(p) } })
    s.stop(); s.transcribed(); await wait(30)
    expect(s.store.meeting(s.m.id)).toMatchObject({ title: 'Mine', titleSource: 'user' })
  })
  it('a title stopped by a recording is asked for again later, and the notes are never written again for it', async () => {
    let recording = false, stopped = false
    let s!: ReturnType<typeof setup>
    s = setup({ title: 'Zoom call', smallMac: true, recording: () => recording, reply: (p) => {
      if (/Now give this meeting a title/.test(p) && !stopped) { stopped = true; recording = true; s.queue.recordingChanged() }
      return reply(p)
    } })
    s.stop(); s.transcribed(); await wait(30)
    expect(s.store.meeting(s.m.id)!.title).toBe('Zoom call')
    recording = false; s.queue.recordingChanged(); await wait(30)
    expect(s.store.meeting(s.m.id)).toMatchObject({ title: 'Pricing with Dana', titleSource: 'auto' })
    expect(s.prompts.filter((p) => !/Now give this meeting a title/.test(p))).toHaveLength(1)
  })
  it('writing the notes again refreshes a title it made', async () => {
    let n = 0
    const s = setup({ title: 'Zoom call', reply: (p) => (/Now give this meeting a title/.test(p) ? `Title ${++n}` : reply(p)) })
    s.stop(); s.transcribed(); await wait(30)
    expect(s.store.meeting(s.m.id)!.title).toBe('Title 1')
    await s.notes.writeAgain(s.m.id); await wait(30)
    expect(s.store.meeting(s.m.id)).toMatchObject({ title: 'Title 2', titleSource: 'auto' })
  })
})

it('inline renaming never rewrites a Summary, even while it is being generated', async () => {
  for (const email of [null, 'jamie@northwind.example']) {
    let s: ReturnType<typeof setup>
    s = setup({ during: () => {
      const before = s.store.meeting(s.m.id)!.attendees
      s.store.renameAttendee(s.m.id, 0, 'Jamie Quill')
      s.notes.renamed(s.m.id, before, s.store.meeting(s.m.id)!.attendees)
    } })
    s.store.updateMeeting(s.m.id, { attendees: [{ name: 'jamie', email }] })
    await s.notes.writeAgain(s.m.id)
    s.notes.applyPeople(s.m.id); await wait(150)
    expect(s.notes.view(s.m.id).peopleChanged).toBe(false)
    expect(s.prompts).toHaveLength(1)
  }
})
