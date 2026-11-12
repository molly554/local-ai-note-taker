import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enhance, enhancePrompt, TEMPLATE_LINES, transcriptHead, type Llm } from '../src/main/notes/enhance'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import { notesStyleSetting } from '../src/main/settings'
import { openStore, type Meeting, type Store } from '../src/main/store'
import { cleanExtra, EXTRA_CHARS, isTemplate, PLAIN_STYLE, TEMPLATES, type NotesStyle, type Template } from '../src/shared/templates'
import type { NoteView } from '../src/shared/types'

const input = { title: 'Sync', attendees: [], mine: '', transcript: 'You: We ship Tuesday.', language: 'English' }
const USE_ONLY = '- Use only what was said or typed. Never make anything up.'
const lines = (prompt: string) => prompt.split('\n')
const style = (s: Partial<NotesStyle>): NotesStyle => ({ ...PLAIN_STYLE, ...s })

describe('the notes prompt with a template', () => {
  it('general is the prompt every Summary had before templates: nothing added, next steps last', () => {
    const before = enhancePrompt(input)
    expect(enhancePrompt({ ...input, style: PLAIN_STYLE })).toBe(before)
    expect(TEMPLATE_LINES.general).toEqual([])
    expect(before).toContain('- Markdown only. Start right away with the first "## " topic: no title, no introduction, nothing after the last bullet.')
    expect(before).toContain('\n- Last, "## Next steps" (in English) only if someone said they would do something after the meeting:')
    expect(before.endsWith('## <topic>\n- <point>\n  - <detail>\n## <topic>\n- <point>\n## Next steps\n- **<Name>:** <task>, by <when>')).toBe(true)
    for (const t of TEMPLATES) for (const line of TEMPLATE_LINES[t]) expect(before).not.toContain(line)
  })

  it('every other template adds its own lines, after the general rules and before "use only what was said"', () => {
    const general = lines(enhancePrompt(input))
    for (const t of TEMPLATES.filter((x) => x !== 'general')) {
      expect(TEMPLATE_LINES[t].length, t).toBeGreaterThan(0)
      const got = lines(enhancePrompt({ ...input, style: style({ template: t }) }))
      const at = got.indexOf(USE_ONLY)
      // the same prompt with the template's lines put in right before that rule, and nothing else changed
      expect(got.slice(at - TEMPLATE_LINES[t].length, at), t).toEqual(TEMPLATE_LINES[t])
      expect([...got.slice(0, at - TEMPLATE_LINES[t].length), ...got.slice(at)], t).toEqual(general)
    }
  })

  it('no template forgets what a general Summary must never do: each says only what its kind of meeting needs', () => {
    // an interview's notes report, they do not judge; a one-on-one keeps what the general rule would leave out
    expect(TEMPLATE_LINES.interview.join(' ')).toMatch(/no verdict, no score/)
    expect(TEMPLATE_LINES['one-on-one'].join(' ')).toMatch(/their workload and their career are the work here/)
    for (const t of TEMPLATES) for (const line of TEMPLATE_LINES[t]) expect(line.startsWith('- '), `${t}: a rule in the list`).toBe(true)
  })

  it('whatever the style, the transcript is still the very start of the prompt (it is read in during the meeting)', () => {
    for (const s of [PLAIN_STYLE, style({ template: 'customer' }), style({ nextStepsFirst: true }), style({ extra: 'Keep it short' })]) {
      expect(enhancePrompt({ ...input, style: s }).startsWith(`${transcriptHead}${input.transcript}\n</transcript>`)).toBe(true)
    }
  })

  it('next steps first: asked for before any topic, and the shape shows them at the top', () => {
    const p = enhancePrompt({ ...input, style: style({ nextStepsFirst: true }) })
    expect(p).toContain('\n- First, before any topic, "## Next steps" (in English) only if someone said they would do something after the meeting:')
    expect(p).not.toContain('- Last, "## Next steps"')
    expect(p).toContain('- Markdown only. Start right away with the first "## " heading:')
    expect(p.endsWith('The shape, with made-up placeholders:\n## Next steps\n- **<Name>:** <task>, by <when>\n## <topic>\n- <point>\n  - <detail>\n## <topic>\n- <point>')).toBe(true)
  })

  it("the person's own request is one more rule, before \"use only what was said\"", () => {
    const got = lines(enhancePrompt({ ...input, style: style({ template: 'team', extra: 'Keep it under ten bullets' }) }))
    const at = got.indexOf(USE_ONLY)
    expect(got[at - 1]).toBe('- The person these notes are for asks this of every summary: Keep it under ten bullets')
    expect(got[at - 2]).toBe(TEMPLATE_LINES.team.at(-1))
    expect(enhancePrompt(input)).not.toContain('asks this of every summary')
  })
})

describe("the person's own request", () => {
  it('is kept on one line and to a length, so it can never push a prompt far past what was counted', () => {
    expect(cleanExtra('  Keep it\nshort.\n\n- and in bullets  ')).toBe('Keep it short. - and in bullets')
    expect(cleanExtra('x'.repeat(EXTRA_CHARS + 50))).toHaveLength(EXTRA_CHARS)
    expect(cleanExtra(undefined)).toBe('')
    expect(cleanExtra(12)).toBe('')
  })
})

describe('Settings → Summary', () => {
  it('starts as it always was: the general template, next steps last, nothing extra', () => {
    expect(notesStyleSetting({})).toEqual(PLAIN_STYLE)
  })
  it("a meeting's own template wins over the one in Settings; anything unknown is not a template", () => {
    expect(notesStyleSetting({ template: 'team', nextStepsFirst: true, notesExtra: ' Short \n please ' })).toEqual({ template: 'team', nextStepsFirst: true, extra: 'Short please' })
    expect(notesStyleSetting({ template: 'team' }, 'interview').template).toBe('interview')
    expect(notesStyleSetting({ template: 'team' }, 'board meeting').template).toBe('team')
    expect(notesStyleSetting({ template: 'weekly' as Template }, null).template).toBe('general')
    expect(isTemplate('one-on-one')).toBe(true)
    expect(isTemplate('1:1')).toBe(false)
  })
})

describe('writing notes with a style', () => {
  const segments = [{ id: 1, meetingId: 'm', track: 'me' as const, startMs: 0, endMs: 1000, text: 'We ship Tuesday.', speaker: null }]
  const base = { meeting: { title: 'Sync', attendees: [] }, mine: '', segments, language: 'english' }

  it('the prompt the model gets carries the template and the request', async () => {
    const prompts: string[] = []
    const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async (prompt) => { prompts.push(prompt); return '## Plan\n- Ship Tuesday\n## Next steps\n- **You:** Ship it.' } }
    await enhance({ ...base, style: style({ template: 'customer', extra: 'Prices in euros' }) }, llm, () => {})
    expect(prompts[0]).toContain(TEMPLATE_LINES.customer[0])
    expect(prompts[0]).toContain('asks this of every summary: Prices in euros')
  })

  it('next steps the model left out are asked for after, and put where the notes were asked to have them', async () => {
    const answers = ['## Plan\n- Ship Tuesday', '## Next steps\n- **You:** Ship it.']
    const llm = (): Llm => { let n = 0; return { contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async () => answers[n++] ?? '' } }
    expect(await enhance(base, llm(), () => {})).toBe('## Plan\n- Ship Tuesday\n## Next steps\n- **You:** Ship it.')
    expect(await enhance({ ...base, style: style({ nextStepsFirst: true }) }, llm(), () => {})).toBe('## Next steps\n- **You:** Ship it.\n## Plan\n- Ship Tuesday')
  })
})

describe("a meeting's own template", () => {
  const dirs: string[] = []
  const stores: Store[] = []
  afterEach(() => {
    stores.splice(0).forEach((s) => s.close())
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  })
  function setup() {
    const d = mkdtempSync(join(tmpdir(), 'notetaker-templates-'))
    dirs.push(d)
    const file = join(d, 'yogurt.db')
    const store = openStore(file)
    stores.push(store)
    const m = store.createMeeting({ title: 'Sync', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'stopped' })
    store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'We ship Tuesday.', speaker: 'Priya Nair' }])
    return { d, file, store, m }
  }

  it('is kept with its notes: none at first, set before any notes exist, and still there when the app opens again', () => {
    const s = setup()
    expect(s.store.noteTemplate(s.m.id)).toBeNull()
    s.store.setNoteTemplate(s.m.id, 'interview')
    expect(s.store.noteTemplate(s.m.id)).toBe('interview')
    // a meeting given a template before it has notes has no notes yet, and is still found as one to write
    expect(s.store.notes(s.m.id)).toEqual({ mine: '', enhanced: null, edited: false })
    expect(s.store.unenhancedMeetings().map((m) => m.id)).toEqual([s.m.id])
    s.store.setNotes(s.m.id, { mine: 'my own', enhanced: '## Plan', edited: true })
    s.store.setNoteTemplate(s.m.id, 'team')
    expect(s.store.notes(s.m.id)).toEqual({ mine: 'my own', enhanced: '## Plan', edited: true })
    s.store.close(); stores.length = 0
    const again = openStore(s.file)
    stores.push(again)
    expect(again.noteTemplate(s.m.id)).toBe('team')
  })

  it('notes are written with the style of the moment, the template they were written with is kept, and writing again with another uses that', async () => {
    const s = setup()
    const settings: { template: Template } = { template: 'team' }
    const prompts: string[] = [], sent: NoteView[] = [], stops: Array<(m: Meeting) => void> = []
    const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async (prompt, onToken) => { prompts.push(prompt); const r = '## Plan\n- We ship Tuesday\n## Next steps\n- **Ann:** Send it.'; onToken(r); return r } }
    const own = (id: string) => { const t = s.store.noteTemplate(id); return isTemplate(t) ? t : undefined }
    const notes = hookNotes({
      store: s.store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm },
      transcribed: async () => {}, language: () => 'english', onStop: (fn) => stops.push(fn), send: (v) => sent.push(v), changed: () => {},
      style: (id) => notesStyleSetting(settings, s.store.noteTemplate(id)), template: own, wroteWith: (id, t) => s.store.setNoteTemplate(id, t),
    })
    // before any notes: the meeting has no template of its own, so the note's view names none
    expect(notes.view(s.m.id).template).toBeUndefined()
    stops.forEach((f) => f(s.m))
    await notes.written(s.m.id)
    expect(prompts.at(-1)).toContain(TEMPLATE_LINES.team[0])
    expect(s.store.noteTemplate(s.m.id)).toBe('team')
    expect(sent.at(-1)).toMatchObject({ status: 'done', template: 'team' })

    // Settings moves on to another template: this meeting keeps the one it was written with
    settings.template = 'customer'
    await notes.writeAgain(s.m.id)
    expect(prompts.at(-1)).toContain(TEMPLATE_LINES.team[0])
    expect(prompts.at(-1)).not.toContain(TEMPLATE_LINES.customer[0])

    // picked for this meeting from its Summary's menu: written again with it, and it is the meeting's own from then on
    expect(notes.canWriteAgain(s.m.id)).toBe(true)
    s.store.setNoteTemplate(s.m.id, 'interview')
    await notes.writeAgain(s.m.id)
    expect(prompts.at(-1)).toContain(TEMPLATE_LINES.interview[0])
    expect(prompts.at(-1)).not.toContain(TEMPLATE_LINES.team[0])
    expect(sent.at(-1)).toMatchObject({ status: 'done', template: 'interview' })
  })
})
