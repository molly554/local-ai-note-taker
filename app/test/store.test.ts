import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore, type Store } from '../src/main/store'

const dirs: string[] = []
const stores: Store[] = []
function fresh(): Store {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-store-'))
  dirs.push(d)
  const s = openStore(join(d, 'yogurt.db'))
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const base = { title: 'Standup', endedAt: null, eventId: null, app: null, attendees: [], state: 'recording' as const }

describe('store', () => {
  it('creates meetings and lists newest first', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'A', startedAt: 1000, attendees: [{ name: 'Ada', email: 'ada@x.io' }] })
    const b = s.createMeeting({ ...base, title: 'B', startedAt: 2000 })
    expect(a.id).not.toBe(b.id)
    expect(s.meetings({ limit: 10 }).map((m) => m.title)).toEqual(['B', 'A'])
    expect(s.meetings({ limit: 10, before: 2000 }).map((m) => m.title)).toEqual(['A'])
    expect(s.meetings({ limit: 1 })).toHaveLength(1)
    expect(s.meetings({ limit: 10 })[1].attendees).toEqual([{ name: 'Ada', email: 'ada@x.io' }])
    s.updateMeeting(a.id, { state: 'done', endedAt: 5000, title: 'A2' })
    expect(s.meetings({ limit: 10 }).find((m) => m.id === a.id)).toMatchObject({ state: 'done', endedAt: 5000, title: 'A2' })
  })

  it('returns segments in startMs order across tracks', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 3000, endMs: 4000, text: 'third', speaker: 'A' },
      { meetingId: m.id, track: 'me', startMs: 1000, endMs: 2000, text: 'first', speaker: 'me' },
      { meetingId: m.id, track: 'them', startMs: 2000, endMs: 3000, text: 'second', speaker: 'A' },
    ])
    const segs = s.segments(m.id)
    expect(segs.map((x) => x.text)).toEqual(['first', 'second', 'third'])
    expect(segs[0].id).toBeTypeOf('number')
  })

  it('reads only the latest lines when asked for a tail, still in time order', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments(Array.from({ length: 200 }, (_, i) => ({ meetingId: m.id, track: i % 2 ? 'them' as const : 'me' as const, startMs: i * 1000, endMs: i * 1000 + 900, text: `line ${i}`, speaker: null, hidden: i === 198 })))
    expect(s.segments(m.id, { last: 3 }).map(x => x.text)).toEqual(['line 196', 'line 197', 'line 199'])
    expect(s.segments(m.id, { hidden: true, last: 3 }).map(x => x.text)).toEqual(['line 197', 'line 198', 'line 199'])
    expect(s.segments(m.id)).toHaveLength(199)
  })

  it('sets the speaker of given lines and leaves the others alone', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'one', speaker: null },
      { meetingId: m.id, track: 'them', startMs: 2000, endMs: 3000, text: 'two', speaker: null },
    ])
    const [a] = s.segments(m.id)
    s.setSegmentSpeakers([{ id: a.id, speaker: 'Dana Smith' }])
    expect(s.segments(m.id).map((x) => x.speaker)).toEqual(['Dana Smith', null])
  })

  it('deleteMeeting removes the meeting with its lines, notes and chat, and search no longer finds it', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, title: 'Budget review', startedAt: 1, state: 'done' })
    const keep = s.createMeeting({ ...base, title: 'Budget plan', startedAt: 2, state: 'done' })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: 'pineapple budget', speaker: 'A' }])
    s.setNotes(m.id, { mine: 'pineapple', enhanced: '## Pineapple' })
    s.addChatTurn(m.id, 'what about pineapple?')
    s.deleteMeeting(m.id)
    expect(s.meeting(m.id)).toBeUndefined()
    expect(s.segments(m.id)).toEqual([])
    expect(s.notes(m.id)).toEqual({ mine: '', enhanced: null, edited: false })
    expect(s.chatTurns(m.id)).toEqual([])
    expect(s.search('pineapple', 10)).toEqual([])
    expect(s.search('budget', 10).map((h) => h.meetingId)).toEqual([keep.id])
  })

  it('stores notes', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    expect(s.notes(m.id)).toEqual({ mine: '', enhanced: null, edited: false })
    s.setNotes(m.id, { mine: 'hello' })
    s.setNotes(m.id, { enhanced: '# Summary' })
    expect(s.notes(m.id)).toEqual({ mine: 'hello', enhanced: '# Summary', edited: false })
    // the person changed the enhanced notes: "Write again" asks first
    s.setNotes(m.id, { enhanced: '# Mine now', edited: true })
    expect(s.notes(m.id)).toEqual({ mine: 'hello', enhanced: '# Mine now', edited: true })
  })

  it('lists stopped meetings whose enhanced notes were never written', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'A', startedAt: 1, state: 'stopped' })
    const b = s.createMeeting({ ...base, title: 'B', startedAt: 2, state: 'stopped' })
    s.createMeeting({ ...base, title: 'C', startedAt: 3, state: 'done' })
    s.createMeeting({ ...base, title: 'D', startedAt: 4 })
    s.setNotes(b.id, { enhanced: '## Done' })
    expect(s.unenhancedMeetings().map((m) => m.id)).toEqual([a.id])
  })

  it('adds the edited column to a notes table from before it existed', () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-store-'))
    dirs.push(d)
    const old = new DatabaseSync(join(d, 'yogurt.db'))
    old.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL UNIQUE, mine TEXT NOT NULL DEFAULT '', enhanced TEXT)`)
    old.close()
    const s = openStore(join(d, 'yogurt.db'))
    stores.push(s)
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.setNotes(m.id, { enhanced: 'x', edited: true })
    expect(s.notes(m.id).edited).toBe(true)
  })

  it('searches transcripts and notes', () => {
    const s = fresh()
    const m1 = s.createMeeting({ ...base, startedAt: 1 })
    const m2 = s.createMeeting({ ...base, startedAt: 2 })
    s.addSegments([{ meetingId: m1.id, track: 'them', startMs: 0, endMs: 1, text: 'We should discuss pricing next week', speaker: 'A' }])
    s.setNotes(m2.id, { mine: 'Revisit the pricing page' })
    const hits = s.search('pricing', 10)
    expect(hits.map((h) => h.meetingId).sort()).toEqual([m1.id, m2.id].sort())
    for (const h of hits) expect(h.snippet.toLowerCase()).toContain('pricing')
    s.setNotes(m2.id, { mine: 'nothing here' })
    expect(s.search('pricing', 10).map((h) => h.meetingId)).toEqual([m1.id])
    expect(s.search('pri"c(', 10)).toEqual([])
    expect(s.search('  ', 10)).toEqual([])
  })

  it('matches the last word as a prefix', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: 'We should discuss pricing', speaker: 'A' }])
    expect(s.search('pric', 10).map((h) => h.meetingId)).toEqual([m.id])
    expect(s.search('discuss pric', 10)).toHaveLength(1)
  })

  it('applies the limit in the search and keeps one hit per meeting', () => {
    const s = fresh()
    const ids = [1, 2, 3].map((i) => s.createMeeting({ ...base, startedAt: i }).id)
    for (const id of ids) {
      s.addSegments([0, 1, 2].map((n) => ({ meetingId: id, track: 'them' as const, startMs: n, endMs: n + 1, text: `pricing ${n}`, speaker: 'A' })))
    }
    expect(s.search('pricing', 10)).toHaveLength(3)
    expect(s.search('pricing', 2)).toHaveLength(2)
  })

  it('keeps notes search correct after VACUUM', () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-store-'))
    dirs.push(d)
    const file = join(d, 'yogurt.db')
    const s = openStore(file)
    stores.push(s)
    const ms = [1, 2, 3, 4].map((i) => s.createMeeting({ ...base, startedAt: i }))
    ms.forEach((m, i) => s.setNotes(m.id, { mine: `note ${i} ${i === 3 ? 'pricing' : 'other'}` }))
    s.setNotes(ms[3].id, { enhanced: 'more pricing' })
    s.db.prepare('DELETE FROM meetings WHERE id = ?').run(ms[0].id)
    s.db.prepare('DELETE FROM meetings WHERE id = ?').run(ms[1].id)
    const other = new DatabaseSync(file)
    other.exec('VACUUM')
    other.close()
    expect(s.search('pricing', 10).map((h) => h.meetingId)).toEqual([ms[3].id])
  })

  it('marks interrupted recordings as stopped', () => {
    const s = fresh()
    s.createMeeting({ ...base, startedAt: 1 })
    s.createMeeting({ ...base, startedAt: 2 })
    s.createMeeting({ ...base, startedAt: 3, state: 'done' })
    expect(s.markInterrupted()).toBe(2)
    expect(s.meetings({ limit: 10 }).map((m) => m.state).sort()).toEqual(['done', 'stopped', 'stopped'])
    expect(s.markInterrupted()).toBe(0)
  })

  it('lists past meetings as cards a page at a time, with the first words of their notes', () => {
    const s = fresh()
    const ms = [1, 2, 2, 3].map((at, i) => s.createMeeting({ ...base, title: `M${i}`, startedAt: at, state: 'done' }))
    s.setNotes(ms[3].id, { mine: 'my own line', enhanced: '## Launch plan\n- The site goes **live** on <mine>Tuesday</mine>.\n- Email after' })
    s.setNotes(ms[0].id, { mine: '- just mine\n- second' })
    const page1 = s.meetingCards({ limit: 2 })
    expect(page1.map((c) => c.title)).toEqual(['M3', ms[2].id > ms[1].id ? 'M2' : 'M1'])
    expect(page1[0].preview).toBe('The site goes live on Tuesday. Email after')
    const last = page1.at(-1)!
    const page2 = s.meetingCards({ limit: 5, before: { at: last.startedAt, id: last.id } })
    // the meeting at the same moment is not lost between pages
    expect([...page1, ...page2].map((c) => c.title).sort()).toEqual(['M0', 'M1', 'M2', 'M3'])
    const all = [...page1, ...page2]
    expect(all.find((c) => c.title === 'M0')!.preview).toBe('just mine second')
    expect(all.find((c) => c.title === 'M1')!.preview).toBe('')
  })

  it('search marks the words it matched, cleans note markup, and keeps raw text as text', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    s.setNotes(m.id, { enhanced: '- The **pricing** page <img src=x onerror=alert(1)> needs <mine>review</mine>' })
    const [hit] = s.search('pricing', 10)
    expect(hit.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['pricing'])
    const text = hit.parts.map((p) => p.text).join('')
    expect(text).toContain('<img src=x onerror=alert(1)>')
    expect(text).not.toContain('**')
    expect(text).not.toContain('<mine>')
    expect(hit.snippet).toBe(text)
    s.setNotes(m.id, { enhanced: '## Budget\n- The pricing stays' })
    expect(s.search('pricing', 10)[0].snippet).toBe('Budget · The pricing stays')
  })

  it('search finds meetings by title, newest first, ahead of the rest', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'Budget review', startedAt: 1 })
    const b = s.createMeeting({ ...base, title: 'Weekly budget', startedAt: 2 })
    const c = s.createMeeting({ ...base, title: 'Other', startedAt: 3 })
    s.setNotes(c.id, { mine: 'the budget is fine' })
    expect(s.search('budg', 10).map((h) => h.meetingId)).toEqual([b.id, a.id, c.id])
  })

  it('search finds Chinese and Japanese words inside a run of characters', () => {
    const s = fresh()
    const m = s.createMeeting({ ...base, startedAt: 1 })
    const n = s.createMeeting({ ...base, startedAt: 2 })
    s.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: '我们下周讨论预算的问题', speaker: 'A' }])
    s.setNotes(n.id, { mine: '来週の会議で予算を確認する' })
    const [hit] = s.search('预算', 10)
    expect(hit.meetingId).toBe(m.id)
    expect(hit.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['预算'])
    expect(s.search('予算', 10).map((h) => h.meetingId)).toEqual([n.id])
    expect(s.search('不在', 10)).toEqual([])
  })

  it('search matches titles by the start of their words, like the text search', () => {
    const s = fresh()
    const a = s.createMeeting({ ...base, title: 'Budget review', startedAt: 1 })
    expect(s.search('get', 10)).toEqual([])
    expect(s.search('budg', 10).map((h) => h.meetingId)).toEqual([a.id])
    expect(s.search('review budg', 10).map((h) => h.meetingId)).toEqual([a.id])
    // words before the last are whole words
    expect(s.search('rev budget', 10)).toEqual([])
  })
})

it('deletes the lines given (echoes found after the meeting) and nothing else; search forgets them', () => {
  const s = openStore(':memory:')
  const m = s.createMeeting({ title: 't', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'budget is twelve euros', speaker: null },
    { meetingId: m.id, track: 'me', startMs: 100, endMs: 1100, text: 'budget is twelve euros', speaker: 'me' },
    { meetingId: m.id, track: 'me', startMs: 3000, endMs: 4000, text: 'zebra pancakes', speaker: 'me' },
  ])
  const echo = s.segments(m.id).find((x) => x.track === 'me' && x.startMs === 100)!
  s.deleteSegments([echo.id])
  expect(s.segments(m.id).map((x) => x.text)).toEqual(['budget is twelve euros', 'zebra pancakes'])
  expect(s.search('zebra', 5)).toHaveLength(1)
  s.deleteSegments([])
  expect(s.segments(m.id)).toHaveLength(2)
})

it("knows the last meeting's language, for Apple's speech to start listening in", () => {
  const s = openStore(':memory:')
  expect(s.lastLanguage()).toBeNull()
  const a = s.createMeeting({ title: 'a', startedAt: 1000, endedAt: 2000, eventId: null, app: null, attendees: [], state: 'done' })
  s.updateMeeting(a.id, { language: 'spanish' })
  s.createMeeting({ title: 'b', startedAt: 3000, endedAt: 4000, eventId: null, app: null, attendees: [], state: 'done' })
  expect(s.lastLanguage()).toBe('spanish')
  const c = s.createMeeting({ title: 'c', startedAt: 5000, endedAt: 6000, eventId: null, app: null, attendees: [], state: 'done' })
  s.updateMeeting(c.id, { language: 'german' })
  expect(s.lastLanguage()).toBe('german')
})

describe('round 2: hidden lines', () => {
  it('a hidden line is kept but left out of the transcript, the preview and search until it is shown again', () => {
    const s = openStore(':memory:')
    const m = s.createMeeting({ title: 't', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
    s.addSegments([
      { meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'budget is twelve euros', speaker: null },
      { meetingId: m.id, track: 'me', startMs: 100, endMs: 1100, text: 'budget is twelve euros', speaker: 'me', hidden: true },
      { meetingId: m.id, track: 'me', startMs: 3000, endMs: 4000, text: 'zebra pancakes', speaker: 'me' },
    ])
    expect(s.segments(m.id).map((x) => x.text)).toEqual(['budget is twelve euros', 'zebra pancakes'])
    expect(s.segments(m.id, { hidden: true }).map((x) => [x.text, x.hidden])).toEqual([['budget is twelve euros', false], ['budget is twelve euros', true], ['zebra pancakes', false]])
    const z = s.segments(m.id).find((x) => x.text === 'zebra pancakes')!
    s.hideSegments([z.id])
    expect(s.segments(m.id).map((x) => x.text)).toEqual(['budget is twelve euros'])
    expect(s.search('zebra', 5)).toEqual([])
    expect(s.preview(m.id)).not.toContain('zebra')
    s.showSegments(m.id)
    expect(s.segments(m.id).map((x) => x.text)).toEqual(['budget is twelve euros', 'budget is twelve euros', 'zebra pancakes'])
    expect(s.search('zebra', 5)).toHaveLength(1)
  })
})

describe('a database from when voices had letters', () => {
  it('loses the letters (those lines say Them) and the speakers table; names from the call are kept from then on', () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-store-')); dirs.push(d)
    const file = join(d, 'y.db')
    const first = openStore(file)
    const m = first.createMeeting({ title: 't', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
    first.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: 'lettered line', speaker: 'A' }, { meetingId: m.id, track: 'me', startMs: 2, endMs: 3, text: 'mine', speaker: 'me' }])
    first.db.exec("CREATE TABLE speakers (meeting_id TEXT, label TEXT, name TEXT)")
    first.close()
    const s = openStore(file); stores.push(s)
    expect(s.segments(m.id).map((x) => x.speaker)).toEqual([null, 'me'])
    expect(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'speakers'").get()).toBeUndefined()
    expect(s.search('lettered', 5)).toHaveLength(1)
    s.setSegmentSpeakers([{ id: s.segments(m.id)[0].id, speaker: 'Dana Smith' }])
    s.close(); stores.pop()
    const again = openStore(file); stores.push(again)
    expect(again.segments(m.id)[0].speaker).toBe('Dana Smith')
  })
})

describe('round 3: the search index and hidden lines, on a fresh database and on one from before', () => {
  const M: Parameters<Store['createMeeting']>[0] = { title: 't', startedAt: 1, endedAt: null, eventId: null, app: null, attendees: [], state: 'done' }
  /** a database written by the app before hidden lines existed: no hidden column, the old unguarded search triggers */
  function oldSchema(file: string) {
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, event_id TEXT, app TEXT,
        attendees TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, language TEXT, labelled_at INTEGER);
      CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        track TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL, speaker TEXT);
      CREATE VIRTUAL TABLE segments_fts USING fts5(text, content='segments', content_rowid='id');
      CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
        INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text); END;`)
    db.prepare("INSERT INTO meetings (id, title, started_at, state) VALUES ('old1', 't', 1, 'done')").run()
    db.prepare("INSERT INTO segments (meeting_id, track, start_ms, end_ms, text, speaker) VALUES ('old1', 'me', 0, 1, 'banana echo line', 'me'), ('old1', 'them', 0, 1, 'banana real', 'A')").run()
    db.close()
  }
  const integrity = (s: Store) => { s.db.exec("INSERT INTO segments_fts(segments_fts, rank) VALUES ('integrity-check', 1)") }
  const segs = (id: string) => [{ meetingId: id, track: 'me' as const, startMs: 0, endMs: 1, text: 'banana echo line', speaker: 'me' }, { meetingId: id, track: 'them' as const, startMs: 0, endMs: 1, text: 'banana real', speaker: 'A' }]
  const steps: Record<string, (s: Store, id: string, b: number) => void> = {
    'hide, show': (s, id, b) => { s.hideSegments([b]); s.showSegments(id) },
    'hide, speaker update, show': (s, id, b) => { s.hideSegments([b]); s.setSegmentSpeakers([{ id: b, speaker: 'C' }]); s.showSegments(id) },
    'hide, delete the meeting': (s, id, b) => { s.hideSegments([b]); s.deleteMeeting(id) },
    'live hidden line, show': (s, id) => { s.addSegments([{ meetingId: id, track: 'me', startMs: 5, endMs: 6, text: 'cherry', speaker: 'me', hidden: true }]); s.showSegments(id) },
    'live hidden line, delete the meeting': (s, id) => { s.addSegments([{ meetingId: id, track: 'me', startMs: 5, endMs: 6, text: 'cherry', speaker: 'me', hidden: true }]); s.deleteMeeting(id) },
  }
  for (const mode of ['from before', 'fresh'] as const) for (const [name, step] of Object.entries(steps)) {
    it(`${mode}: ${name} leaves the search index whole`, () => {
      const d = mkdtempSync(join(tmpdir(), 'yogurt-store-')); dirs.push(d)
      const file = join(d, 'y.db')
      if (mode === 'from before') oldSchema(file)
      const s = openStore(file); stores.push(s)
      const id = mode === 'from before' ? 'old1' : s.createMeeting(M).id
      if (mode === 'fresh') s.addSegments(segs(id))
      const other = s.createMeeting(M).id
      s.addSegments([{ meetingId: other, track: 'them', startMs: 0, endMs: 1, text: 'banana other', speaker: 'A' }])
      const b = s.segments(id).find((x) => x.track === 'me')!.id
      step(s, id, b)
      expect(() => integrity(s)).not.toThrow()
      // the other meeting is still found; a hidden line never is
      expect(s.search('banana', 10).some((h) => h.meetingId === other)).toBe(true)
    })
  }
  it('thirty meetings with hidden lines can be deleted, search stays right and the index can be optimized', () => {
    const s = openStore(':memory:')
    const keep = s.createMeeting(M).id
    s.addSegments([{ meetingId: keep, track: 'them', startMs: 0, endMs: 1, text: 'banana other meeting', speaker: 'A' }])
    for (let k = 0; k < 30; k++) {
      const id = s.createMeeting(M).id
      s.addSegments([{ meetingId: id, track: 'me', startMs: 0, endMs: 1, text: 'banana echo line ' + k, speaker: 'me', hidden: true }, { meetingId: id, track: 'them', startMs: 0, endMs: 1, text: 'kiwi ' + k, speaker: 'A' }])
      expect(() => s.deleteMeeting(id)).not.toThrow()
    }
    for (let k = 0; k < 20; k++) { const id = s.createMeeting(M).id; s.addSegments(Array.from({ length: 10 }, (_, j) => ({ meetingId: id, track: 'them' as const, startMs: j, endMs: j + 1, text: 'banana words ' + k + ' ' + j, speaker: 'A' }))) }
    expect(s.search('banana', 500)).toHaveLength(21)
    expect((s.db.prepare("SELECT count(*) n FROM segments_fts WHERE segments_fts MATCH 'banana'").get() as { n: number }).n).toBe(201)
    expect(() => s.db.exec("INSERT INTO segments_fts(segments_fts) VALUES ('optimize')")).not.toThrow()
    expect(() => integrity(s)).not.toThrow()
  })
  it('a database from before: hide and show twice, then delete with a hidden line', () => {
    const d = mkdtempSync(join(tmpdir(), 'yogurt-store-')); dirs.push(d)
    const file = join(d, 'y.db'); oldSchema(file)
    const s = openStore(file); stores.push(s)
    const b = s.segments('old1').find((x) => x.track === 'me')!.id
    s.hideSegments([b]); s.showSegments('old1'); expect(() => integrity(s)).not.toThrow()
    s.hideSegments([b]); s.showSegments('old1'); expect(() => integrity(s)).not.toThrow()
    s.hideSegments([b]); expect(() => s.deleteMeeting('old1')).not.toThrow(); expect(() => integrity(s)).not.toThrow()
  })
})

it('persists speaker order across reopening and late attribution, including hidden history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-colours-')); dirs.push(dir)
  const file = join(dir, 'yogurt.db')
  const first = openStore(file)
  const m = first.createMeeting({ ...base, startedAt: 1 })
  first.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 1, text: 'Unknown', speaker: null },
    { meetingId: m.id, track: 'me', startMs: 1, endMs: 2, text: 'Mine', speaker: 'Me' },
    { meetingId: m.id, track: 'them', startMs: 2, endMs: 3, text: 'First name', speaker: 'Ada', hidden: true },
    { meetingId: m.id, track: 'them', startMs: 3, endMs: 4, text: 'Second name', speaker: 'Bo' },
  ])
  expect(first.speakerOrder(m.id)).toEqual(['Ada', 'Bo'])
  first.close()
  const second = openStore(file); stores.push(second)
  expect(second.speakerOrder(m.id)).toEqual(['Ada', 'Bo'])
  second.setSegmentSpeakers([{ id: second.segments(m.id)[0].id, speaker: 'Cy' }])
  expect(second.speakerOrder(m.id)).toEqual(['Ada', 'Bo', 'Cy'])
  expect(second.speakerOrder(m.id, 'Dee')).toEqual(['Ada', 'Bo', 'Cy', 'Dee'])
  expect(second.speakerOrder(m.id, 'Ada')).toEqual(['Ada', 'Bo', 'Cy', 'Dee'])
  second.db.exec("CREATE TRIGGER fail_colours BEFORE UPDATE OF speaker_order ON meetings BEGIN SELECT RAISE(FAIL, 'test failure'); END")
  expect(second.speakerOrder(m.id, 'Eli')).toEqual(['Ada', 'Bo', 'Cy', 'Dee'])
  second.db.exec('DROP TRIGGER fail_colours')
  expect(second.speakerOrder(m.id, 'Eli')).toEqual(['Ada', 'Bo', 'Cy', 'Dee', 'Eli'])
})


it('retains confident echoes through storage and the final sweep, and restores their normal visibility', () => {
  const s = openStore(':memory:')
  const m = s.createMeeting({ title: 't', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  s.addSegments([{ meetingId: m.id, track: 'me', startMs: 0, endMs: 1000, text: 'quiet echo', speaker: 'me', hidden: true, echoConfident: true },
    { meetingId: m.id, track: 'me', startMs: 2000, endMs: 3000, text: 'later echo', speaker: 'me' }])
  const late = s.segments(m.id)[0]
  s.hideSegments([late.id], [late.id])
  expect(s.segments(m.id)).toEqual([])
  expect(s.segments(m.id, { hidden: true }).every(line => line.echoConfident)).toBe(true)
  expect(s.search('echo', 5)).toEqual([])
  s.showSegments(m.id, [late.id])
  expect(s.segments(m.id)).toMatchObject([{ text: 'later echo', hidden: false }])
  expect(s.segments(m.id)[0].echoConfident).toBeUndefined()
  s.close()
})

it('backfills only strong word matches among already hidden historical echoes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-echo-confidence-')); dirs.push(dir)
  const file = join(dir, 'y.db'), s = openStore(file)
  const m = s.createMeeting({ title: 't', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'done' })
  s.addSegments([
    { meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'we should move the launch to friday morning', speaker: null },
    { meetingId: m.id, track: 'me', startMs: 0, endMs: 1000, text: 'we should move the launch to friday morning', speaker: 'me', hidden: true },
    { meetingId: m.id, track: 'me', startMs: 0, endMs: 1000, text: 'we should move the launch beyond monday evening', speaker: 'me', hidden: true },
  ])
  s.db.exec('ALTER TABLE segments DROP COLUMN echo_confident'); s.close()
  const reopened = openStore(file)
  expect(reopened.segments(m.id, { hidden: true }).filter(line => line.hidden).map(line => !!line.echoConfident)).toEqual([true, false])
  reopened.close()
})
