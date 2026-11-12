import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANSWER_TOKENS, ask, chatContext, chatPrompt, excerptHead, EXCERPT_TOKENS, hookChat, warm } from '../src/main/chat'
import { transcriptText, type Llm } from '../src/main/notes/enhance'
import { readAheadText } from '../src/main/notes/readAhead'
import { createQueue, type JobKind } from '../src/main/notes/queue'
import { openStore, type Segment, type Store } from '../src/main/store'
import type { ChatView } from '../src/shared/types'
import { cleanAnswer, streamCleaner } from '../src/engine/control'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-chat-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const meeting = { title: 'Website launch', attendees: [{ name: 'Ann Lee', email: null }] }
const seg = (id: number, track: 'me' | 'them', text: string, speaker: string | null = track === 'them' ? 'A' : null): Segment =>
  ({ id, meetingId: 'm', track, startMs: id * 5000, endMs: id * 5000 + 4000, text, speaker })
/** you and Speaker A take turns; line 7 is the only one about pricing */
const talk = (): Segment[] => Array.from({ length: 20 }, (_, i) => seg(i + 1, i % 2 ? 'them' : 'me',
  i === 7 ? 'The pricing page needs another review before launch.' : `We talked about item number ${i + 1} for a while.`))

describe('chatContext: what the model reads to answer a question about one meeting', () => {
  it('has the enhanced notes and the whole transcript when it fits, starting the way the read ahead does', () => {
    const segs = talk()
    const ctx = chatContext(meeting, { mine: 'my own line', enhanced: '## Launch\n- Goes live Tuesday', edited: false }, segs, 100_000)
    expect(ctx).toContain('## Launch\n- Goes live Tuesday')
    expect(ctx).toContain(transcriptText(segs))
    // the transcript read in during the meeting is the start of this, so only the rest is new
    expect(ctx.startsWith(readAheadText(transcriptText(segs).split('\n').slice(0, 12)))).toBe(true)
  })
  it('without enhanced notes yet (during the meeting), has the notes the person typed', () => {
    const ctx = chatContext(meeting, { mine: 'ask about the budget', enhanced: null, edited: false }, talk(), 100_000)
    expect(ctx).toContain('ask about the budget')
  })
  it('with a tiny limit, keeps the turns with the words of the question (and the notes), and marks what was left out', () => {
    const segs = talk()
    const ctx = chatContext(meeting, { mine: '', enhanced: '- Launch Tuesday', edited: false }, segs, 200, { hits: [8] })
    expect(ctx).toContain('The pricing page needs another review before launch.')
    expect(ctx).toContain('- Launch Tuesday')
    expect(ctx).not.toContain('item number 1 ')
    expect(ctx).not.toContain('item number 20')
    expect(ctx).toContain('…')
    // the turns kept stay in order, neighbours first: the turn before the hit comes along when it fits
    expect(ctx.indexOf('item number 7 ')).toBeLessThan(ctx.indexOf('pricing'))
  })
  it('with nothing matching and too little room, keeps the latest turns (what was just said)', () => {
    const ctx = chatContext(meeting, { mine: '', enhanced: null, edited: false }, talk(), 160, { hits: [] })
    expect(ctx).toContain('item number 20')
    expect(ctx).not.toContain('item number 2 ')
  })
  it('a meeting too long to read whole is cut to EXCERPT_TOKENS of transcript, even with more room: reading a full window takes minutes', () => {
    // about 40,000 tokens of talk (a token a character here)
    const long = Array.from({ length: 400 }, (_, i) => seg(i + 1, i % 2 ? 'them' : 'me', `${i === 200 ? 'The pricing page needs another review. ' : ''}${'word '.repeat(20)}`))
    const count = (s: string) => s.length
    const ctx = chatContext(meeting, { mine: '', enhanced: null, edited: false }, long, 30_000, { hits: [201], count })
    expect(ctx.startsWith(excerptHead)).toBe(true)
    expect(ctx).toContain('pricing page')
    expect(count(ctx)).toBeLessThanOrEqual(EXCERPT_TOKENS + count(excerptHead) + 400)
    expect(count(ctx)).toBeGreaterThan(EXCERPT_TOKENS * 0.9)
  })
  it('a meeting that fits is still read whole, however long (it is read ahead before the question)', () => {
    const long = Array.from({ length: 400 }, (_, i) => seg(i + 1, i % 2 ? 'them' : 'me', 'word '.repeat(20)))
    const ctx = chatContext(meeting, { mine: '', enhanced: null, edited: false }, long, 60_000, { hits: [], count: (s) => s.length })
    expect(ctx.startsWith(excerptHead)).toBe(false)
  })
})

describe('store: turns that say the words of a question, within one meeting', () => {
  it('finds lines with any of the words, best first, only in that meeting', () => {
    const s = fresh()
    const base = { endedAt: null, eventId: null, app: null, attendees: [], state: 'done' as const }
    const a = s.createMeeting({ ...base, title: 'A', startedAt: 1 })
    const b = s.createMeeting({ ...base, title: 'B', startedAt: 2 })
    s.addSegments([
      { meetingId: a.id, track: 'me', startMs: 0, endMs: 1, text: 'hello there', speaker: null },
      { meetingId: a.id, track: 'them', startMs: 2, endMs: 3, text: 'the pricing page is late', speaker: 'A' },
      { meetingId: b.id, track: 'them', startMs: 2, endMs: 3, text: 'pricing in the other meeting', speaker: 'A' },
    ])
    const ids = s.segments(a.id).map((x) => x.id)
    expect(s.segmentHits(a.id, 'What did they say about "pricing"?')).toEqual([ids[1]])
    expect(s.segmentHits(a.id, '')).toEqual([])
  })
  it('keeps each meeting’s chat', () => {
    const s = fresh()
    const m = s.createMeeting({ endedAt: null, eventId: null, app: null, attendees: [], state: 'done', title: 'A', startedAt: 1 })
    const id = s.addChatTurn(m.id, 'When is launch?')
    s.setChatAnswer(id, 'Tuesday.')
    expect(s.chatTurns(m.id)).toEqual([{ id, question: 'When is launch?', answer: 'Tuesday.', stopped: false }])
    s.clearChat(m.id)
    expect(s.chatTurns(m.id)).toEqual([])
  })
})

/** a model that answers in pieces, remembering what it was asked */
function fakeLlm(answer = 'It goes live on **Tuesday**.') {
  const prompts: string[] = []
  const llm: Llm = {
    contextSize: 32_768,
    count: async (texts) => texts.map((t) => Math.ceil(t.length / 4)),
    chat: async (prompt, onToken) => {
      prompts.push(prompt)
      for (const w of answer.match(/\S+\s*/g) ?? []) { await new Promise((r) => setTimeout(r, 1)); onToken(w) }
      return answer
    },
  }
  return { llm, prompts }
}

function seeded() {
  const store = fresh()
  const m = store.createMeeting({ endedAt: 2, eventId: null, app: null, attendees: [], state: 'done', title: 'Website launch', startedAt: 1 })
  store.addSegments(talk().map((x) => ({ ...x, meetingId: m.id })))
  store.setNotes(m.id, { enhanced: '## Launch\n- Goes live Tuesday' })
  return { store, id: m.id }
}

describe('ask: one question, through the model queue as a chat job', () => {
  it('streams the answer; the prompt has the context, earlier questions, then the question last, in the person’s language', async () => {
    const { store, id } = seeded()
    const kinds: JobKind[] = []
    const q = createQueue({ recording: () => false, smallMac: false })
    const queue = { ...q, enqueue: (job: Parameters<typeof q.enqueue>[0], kind: JobKind) => { kinds.push(kind); return q.enqueue(job, kind) } }
    const { llm, prompts } = fakeLlm()
    let out = ''
    for await (const t of ask({ store, queue, model: { llm: async () => llm } }, id, 'When does it go live?', [{ question: 'Who was there?', answer: 'You and Ann.' }])) out += t
    expect(out).toBe('It goes live on **Tuesday**.')
    expect(kinds).toEqual(['chat'])
    const p = prompts[0]
    expect(p.startsWith(readAheadText(transcriptText(store.segments(id)).split('\n')))).toBe(true)
    expect(p).toContain('Who was there?')
    expect(p).toContain('You and Ann.')
    expect(p.trimEnd().endsWith('When does it go live?\n</question>')).toBe(true)
    expect(p).toMatch(/language the question is written in/)
  })
  it('a stop ends it early, quietly', async () => {
    const { store, id } = seeded()
    const stop = new AbortController()
    const { llm } = fakeLlm('one two three four five six seven eight')
    const slow: Llm = { ...llm, chat: async (prompt, onToken) => { for (const w of ['one ', 'two ', 'three ']) { if (stop.signal.aborted) throw new Error('Stopped'); onToken(w); await new Promise((r) => setTimeout(r, 5)) } return '' } }
    let out = ''
    for await (const t of ask({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => slow } }, id, 'Hi?', [], { signal: stop.signal })) { out += t; stop.abort() }
    expect(out).toBe('one ')
  })
  it('during a recording it says the meeting is still going on', () => {
    expect(chatPrompt({ context: 'x', question: 'q', history: [], recording: true })).toMatch(/still going on/)
    expect(chatPrompt({ context: 'x', question: 'q', history: [], recording: false })).not.toMatch(/still going on/)
  })
})

describe('hookChat: the conversation the window shows, kept per meeting', () => {
  it.each([
    ['Draft preamble.<channel|>Final answer.', 'Final answer.'],
    ['Draft preamble.<channel|><thought>Unfinished draft', ''],
  ])('saves the cleaned final answer when it differs from streamed text: %s', async (raw, answer) => {
    const { store, id } = seeded()
    const { llm: base, prompts } = fakeLlm()
    let first = true
    const llm: Llm = { ...base, chat: async (prompt, onToken, opts) => {
      if (!first) return base.chat(prompt, onToken, opts)
      first = false
      const clean = streamCleaner()
      for (const chunk of raw.match(/.{1,5}/g) ?? []) onToken(clean.push(chunk))
      onToken(clean.end())
      return cleanAnswer(raw)
    } }
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => false })
    await chat.ask(id, 'First question?')
    expect(chat.view(id).turns[0]).toMatchObject({ answer, status: 'done' })
    expect(store.chatTurns(id)[0].answer).toBe(answer)
    await chat.ask(id, 'Next question?')
    expect(prompts[0]).not.toContain('Draft preamble')
    expect(prompts[0]).not.toContain('Unfinished draft')
  })
  it('asks, streams the answer into the view, and saves it', async () => {
    const { store, id } = seeded()
    const views: ChatView[] = []
    const { llm } = fakeLlm()
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: (v) => views.push(v), waitsForMeeting: () => false })
    await chat.ask(id, '  When does it go live?  ')
    const last = chat.view(id)
    expect(last.turns).toEqual([expect.objectContaining({ question: 'When does it go live?', answer: 'It goes live on **Tuesday**.', status: 'done' })])
    expect(views.some((v) => v.turns[0]?.status === 'answering')).toBe(true)
    expect(store.chatTurns(id)[0].answer).toBe('It goes live on **Tuesday**.')
    // a second question carries the first as history
    await chat.ask(id, 'And the email?')
    expect(chat.view(id).turns).toHaveLength(2)
  })
  it('stop keeps what was written so far', async () => {
    const { store, id } = seeded()
    let release: () => void = () => {}
    const llm: Llm = { contextSize: 32_768, count: async (t) => t.map((x) => x.length), chat: async (_p, onToken) => { onToken('Half '); await new Promise<void>((r) => { release = r }); onToken('more'); return 'A late final answer after cancellation' } }
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => false })
    const done = chat.ask(id, 'Q?')
    await new Promise((r) => setTimeout(r, 20))
    chat.stop(id)
    release()
    await done
    expect(chat.view(id).turns[0]).toMatchObject({ answer: 'Half', status: 'stopped' })
    expect(store.chatTurns(id)[0]).toMatchObject({ answer: 'Half', stopped: true })
  })
  it('clear empties it', async () => {
    const { store, id } = seeded()
    const { llm } = fakeLlm()
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => false })
    await chat.ask(id, 'Q?')
    chat.clear(id)
    expect(chat.view(id).turns).toEqual([])
    expect(store.chatTurns(id)).toEqual([])
  })
})

describe('answers never call people by the speaker letters', () => {
  it('the prompt is written for the transcript\'s labels (You, Them, names) and never talks of letters', () => {
    const p = chatPrompt({ context: 'x', question: 'q', history: [], recording: false })
    expect(p).toMatch(/"Them" in the transcript is not a name/)
    for (const x of [p, excerptHead]) expect(x).not.toMatch(/Speaker [A-Z]\b|letter/)
  })
})

describe('fix round 1', () => {
  const blocked = () => {
    // a 16 GB Mac while it records: the question waits in the queue
    let recording = true
    const queue = createQueue({ recording: () => recording, smallMac: true })
    return { queue, end: () => { recording = false; queue.recordingChanged() } }
  }
  it('says when answers wait for the notes model to arrive (first run)', async () => {
    const { store, id } = seeded()
    let have = false
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => fakeLlm().llm }, send: () => {}, waitsForMeeting: () => false, waitsForModel: () => !have })
    expect(chat.view(id).waitsForModel).toBe(true)
    have = true
    expect(chat.view(id).waitsForModel).toBe(false)
  })
  it('stop while the question still waits for the model: stopped at once, and a new question works', async () => {
    const { store, id } = seeded()
    const { queue, end } = blocked()
    const { llm } = fakeLlm()
    const chat = hookChat({ store, queue, model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => true })
    const first = chat.ask(id, 'First?')
    await new Promise((r) => setTimeout(r, 10))
    expect(chat.view(id).turns[0].status).toBe('waiting')
    chat.stop(id)
    await first
    expect(chat.view(id).turns[0].status).toBe('stopped')
    const second = chat.ask(id, 'Second?')
    end()
    await second
    expect(chat.view(id).turns.map((t) => t.status)).toEqual(['stopped', 'done'])
  })
  it('clear while the question waits: empty, and a new question works', async () => {
    const { store, id } = seeded()
    const { queue, end } = blocked()
    const { llm } = fakeLlm()
    const chat = hookChat({ store, queue, model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => true })
    const first = chat.ask(id, 'First?')
    await new Promise((r) => setTimeout(r, 10))
    chat.clear(id)
    await first
    expect(chat.view(id).turns).toEqual([])
    const second = chat.ask(id, 'Second?')
    end()
    await second
    expect(chat.view(id).turns.map((t) => t.status)).toEqual(['done'])
  })
  it('a recording that stops the answer midway: the partial answer goes, it waits, then answers in full', async () => {
    const { store, id } = seeded()
    let recording = false
    const queue = createQueue({ recording: () => recording, smallMac: true })
    let calls = 0
    const llm: Llm = {
      contextSize: 32_768, count: async (t) => t.map((x) => Math.ceil(x.length / 4)),
      chat: async (_p, onToken) => {
        calls++
        for (const w of ['one ', 'two ', 'three']) {
          onToken(w)
          await new Promise((r) => setTimeout(r, 40))
          if (calls === 1 && recording) throw new Error('Stopped')
        }
        return 'one two three'
      },
    }
    const views: ChatView[] = []
    const chat = hookChat({ store, queue, model: { llm: async () => llm }, send: (v) => views.push(v), waitsForMeeting: () => recording })
    const done = chat.ask(id, 'Q?')
    await new Promise((r) => setTimeout(r, 50))
    expect(chat.view(id).turns[0]).toMatchObject({ answer: expect.stringContaining('one'), status: 'answering' })
    recording = true; queue.recordingChanged()
    await new Promise((r) => setTimeout(r, 70))
    expect(chat.view(id).turns[0]).toMatchObject({ answer: '', status: 'waiting' })
    recording = false; queue.recordingChanged()
    await done
    expect(chat.view(id).turns[0]).toMatchObject({ answer: 'one two three', status: 'done' })
    expect(calls).toBe(2)
  })
  it('a small context with long notes and a long chat: the prompt and its answer fit, and transcript is still in it', async () => {
    const store = fresh()
    const m = store.createMeeting({ endedAt: 2, eventId: null, app: null, attendees: [], state: 'done', title: 'Long', startedAt: 1 })
    store.addSegments(Array.from({ length: 300 }, (_, i) => ({ meetingId: m.id, track: i % 2 ? 'them' as const : 'me' as const, startMs: i * 1000, endMs: i * 1000 + 900, text: `Line ${i} talks about the budget for the spring launch.`, speaker: i % 2 ? 'A' : null })))
    store.setNotes(m.id, { enhanced: Array.from({ length: 400 }, (_, i) => `- Note bullet number ${i} with some detail.`).join('\n') })
    const prompts: string[] = []
    // CJK-free text: four characters a token, counted exactly
    const count = (t: string) => Math.ceil(t.length / 4)
    const llm: Llm = { contextSize: 4096, count: async (t) => t.map(count), chat: async (p) => { prompts.push(p); return 'ok' } }
    const history = Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i}?`, answer: 'A long answer. '.repeat(200) }))
    for await (const _ of ask({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm } }, m.id, 'What about the budget?', history)) { /* drained */ }
    expect(count(prompts[0]) + ANSWER_TOKENS).toBeLessThanOrEqual(4096)
    expect(prompts[0]).toMatch(/Line \d+ talks about the budget/)
    expect(prompts[0]).toContain('What about the budget?')
  })
  it('CJK questions find lines (no spaces between words), and one-letter CJK words count', () => {
    const s = fresh()
    const m = s.createMeeting({ endedAt: null, eventId: null, app: null, attendees: [], state: 'done', title: 'A', startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'me', startMs: 0, endMs: 1, text: '今天天气很好', speaker: null },
      { meetingId: m.id, track: 'them', startMs: 2, endMs: 3, text: '我们讨论了明年的预算问题', speaker: 'A' },
    ])
    const ids = s.segments(m.id).map((x) => x.id)
    expect(s.segmentHits(m.id, '预算是多少？')).toEqual([ids[1]])
  })
  it('lines with only common words don’t crowd out the turns around the best match', () => {
    const segs = talk()
    // the best hit is line 8 (pricing); the rest matched only "the"
    const ctx = chatContext(meeting, { mine: '', enhanced: null, edited: false }, segs, 250, { hits: [8, 1, 3, 5, 12, 14, 16, 18, 20] })
    expect(ctx).toContain('item number 7 ')
    expect(ctx).toContain('item number 9 ')
  })
  it('a stopped answer stays stopped after a reload and is not carried as history', async () => {
    const { store, id } = seeded()
    let release: () => void = () => {}
    const llm: Llm = { contextSize: 32_768, count: async (t) => t.map((x) => x.length), chat: async (_p, onToken) => { onToken('Half '); await new Promise<void>((r) => { release = r }); return 'Half' } }
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => false })
    const done = chat.ask(id, 'Q?')
    await new Promise((r) => setTimeout(r, 20))
    chat.stop(id); release(); await done
    const again = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => fakeLlm().llm }, send: () => {}, waitsForMeeting: () => false })
    expect(again.view(id).turns[0]).toMatchObject({ answer: 'Half', status: 'stopped' })
    const { llm: next, prompts } = fakeLlm()
    const third = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => next }, send: () => {}, waitsForMeeting: () => false })
    await third.ask(id, 'Next?')
    expect(prompts[0]).not.toContain('<asked>')
  })
  it('a question about a meeting that is gone fails plainly; trying again replaces the failed turn', async () => {
    const store = fresh()
    const { llm } = fakeLlm()
    const chat = hookChat({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => false })
    await chat.ask('missing', 'Q?')
    expect(chat.view('missing').turns).toEqual([expect.objectContaining({ question: 'Q?', status: 'failed' })])

    const { store: s2, id } = seeded()
    let fail = true
    const flaky: Llm = { ...llm, chat: async (p, onToken, o) => { if (fail) { fail = false; throw new Error('boom') } return llm.chat(p, onToken, o) } }
    const chat2 = hookChat({ store: s2, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => flaky }, send: () => {}, waitsForMeeting: () => false })
    await chat2.ask(id, 'Q?')
    expect(chat2.view(id).turns[0].status).toBe('failed')
    await chat2.ask(id, 'Q?')
    expect(chat2.view(id).turns).toEqual([expect.objectContaining({ question: 'Q?', status: 'done' })])
    expect(s2.chatTurns(id)).toHaveLength(1)
  })
  it('a recording that stops the answer midway, on an engine that just returns what it had (the real one): starts over cleanly', async () => {
    const { store, id } = seeded()
    let recording = false
    const queue = createQueue({ recording: () => recording, smallMac: true })
    let calls = 0
    const llm: Llm = {
      contextSize: 32_768, count: async (t) => t.map((x) => Math.ceil(x.length / 4)),
      chat: async (_p, onToken) => {
        calls++
        let out = ''
        for (const w of ['one ', 'two ', 'three']) {
          // stopped: the real engine ends the answer there and returns it, no error
          if (calls === 1 && recording) return out
          onToken(w); out += w
          await new Promise((r) => setTimeout(r, 40))
        }
        return out
      },
    }
    const chat = hookChat({ store, queue, model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => recording })
    const done = chat.ask(id, 'Q?')
    await new Promise((r) => setTimeout(r, 50))
    recording = true; queue.recordingChanged()
    await new Promise((r) => setTimeout(r, 70))
    expect(chat.view(id).turns[0]).toMatchObject({ answer: '', status: 'waiting' })
    recording = false; queue.recordingChanged()
    await done
    expect(chat.view(id).turns[0]).toMatchObject({ answer: 'one two three', status: 'done' })
  })
  it('the person stopping while the queue stops it too: it stays stopped, nothing starts over', async () => {
    const { store, id } = seeded()
    let recording = false
    const queue = createQueue({ recording: () => recording, smallMac: true })
    let calls = 0
    const llm: Llm = {
      contextSize: 32_768, count: async (t) => t.map((x) => Math.ceil(x.length / 4)),
      chat: async (_p, onToken) => { calls++; onToken('Half '); await new Promise((r) => setTimeout(r, 40)); return 'Half ' },
    }
    const chat = hookChat({ store, queue, model: { llm: async () => llm }, send: () => {}, waitsForMeeting: () => recording })
    const done = chat.ask(id, 'Q?')
    await new Promise((r) => setTimeout(r, 15))
    chat.stop(id)
    recording = true; queue.recordingChanged()
    await done
    await new Promise((r) => setTimeout(r, 60))
    recording = false; queue.recordingChanged()
    await new Promise((r) => setTimeout(r, 60))
    expect(chat.view(id).turns[0]).toMatchObject({ answer: 'Half', status: 'stopped' })
    expect(calls).toBe(1)
  })
})

describe('warm: the meeting read in before the question, so asking only reads the question', () => {
  /** a model that reads ahead too, remembering what it read */
  function reading(contextSize = 32_768) {
    const { llm, prompts } = fakeLlm()
    const read: string[] = []
    return { llm: { ...llm, contextSize, readAhead: async (text: string) => { read.push(text) } } as Llm, prompts, read }
  }
  const queue = () => createQueue({ recording: () => false, smallMac: false })
  const strictPrefix = (read: string, prompt: string) => {
    expect(read.length).toBeGreaterThan(0)
    expect(prompt.length).toBeGreaterThan(read.length)
    expect(prompt.startsWith(read)).toBe(true)
  }
  it('reads a strict start of the prompt the question then sends, with notes and history', async () => {
    const { store, id } = seeded()
    const r = reading()
    const d = { store, queue: queue(), model: { llm: async () => r.llm } }
    await warm(d, id)
    expect(r.read).toHaveLength(1)
    expect(r.read[0]).toContain('## Launch')
    for await (const _ of ask(d, id, 'When does it go live?', [{ question: 'Who was there?', answer: 'You and Ann.' }])) { /* drained */ }
    strictPrefix(r.read[0], r.prompts[0])
  })
  it('a meeting without notes too', async () => {
    const store = fresh()
    const m = store.createMeeting({ endedAt: 2, eventId: null, app: null, attendees: [{ name: 'Ann Lee', email: null }], state: 'done', title: 'No notes', startedAt: 1 })
    store.addSegments(talk().map((x) => ({ ...x, meetingId: m.id })))
    const r = reading()
    const d = { store, queue: queue(), model: { llm: async () => r.llm } }
    await warm(d, m.id)
    for await (const _ of ask(d, m.id, 'What about pricing?', [])) { /* drained */ }
    strictPrefix(r.read[0], r.prompts[0])
  })
  it('runs as a read ahead (lowest priority) and reads nothing when the transcript does not fit whole', async () => {
    const store = fresh()
    const m = store.createMeeting({ endedAt: 2, eventId: null, app: null, attendees: [], state: 'done', title: 'Long', startedAt: 1 })
    store.addSegments(Array.from({ length: 600 }, (_, i) => ({ meetingId: m.id, track: 'me' as const, startMs: i * 1000, endMs: i * 1000 + 900, text: `Line ${i} talks about the budget for the spring launch.`, speaker: null })))
    const r = reading(4096)
    const kinds: JobKind[] = []
    const q = queue()
    await warm({ store, queue: { enqueue: (job, kind, mid) => { kinds.push(kind); return q.enqueue(job, kind, mid) } }, model: { llm: async () => r.llm } }, m.id)
    expect(kinds).toEqual(['readahead'])
    expect(r.read).toEqual([])
  })
})

describe('ask: says which step it is on', () => {
  it('loading only when the model has to load, then reading the meeting by its title', async () => {
    const { store, id } = seeded()
    for (const needsLoad of [true, false]) {
      const { llm } = fakeLlm()
      const steps: unknown[] = []
      for await (const _ of ask({ store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm, needsLoad: () => needsLoad } }, id, 'Hi?', [], { onStep: (s) => steps.push(s) })) { /* drained */ }
      expect(steps).toEqual([...(needsLoad ? [{ kind: 'loading' }] : []), { kind: 'reading', title: 'Website launch' }])
    }
  })
})
