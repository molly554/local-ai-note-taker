// Chinese search on real meetings: does the app's search show the meetings a word is in?
//   node bench/real-meetings/fetch.mjs                                                        once
//   pnpm --dir app exec vitest run --config ../bench/real-meetings/vitest.config.mjs          after pnpm install
// The 259 Mandarin meetings (AISHELL-4 test and VCSum) go into the app's own Store, and its search() is asked for
// ordinary meeting words, 30 results at a time as the search window does. The words were fixed before any result was
// seen, and all of them are reported. Meeting ids are random, so which meetings a common word shows changes a little
// from run to run. It runs under the project's test runner because the Store's code needs it to load; it measures
// and writes results-search.json, it does not pass or fail on the numbers.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../../app/src/main/store'
import { aishell4, here, vcsum } from './meetings.mjs'

const WORDS = ['我们', '问题', '市场', '技术', '客户', '数据', '项目', '合作', '预算', '物业', '区块链', '人工智能', '供应链', '董事会', '鲸鲨']
const LIMIT = 30
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

it('search on real Mandarin meetings', () => {
  const meetings = [...aishell4(), ...vcsum()]
  const store = openStore(':memory:')
  const idOf = new Map()
  const t0 = performance.now()
  meetings.forEach((m, i) => {
    const made = store.createMeeting({ title: `Meeting ${i + 1}`, startedAt: Date.UTC(2026, 0, 1) + i * 86_400_000, endedAt: null, eventId: null, app: null, attendees: [], state: 'done' })
    idOf.set(m.id, made.id)
    store.addSegments(m.lines.map((l) => ({ meetingId: made.id, track: 'them', startMs: l.startMs, endMs: l.endMs, text: l.text, speaker: l.speaker })))
  })
  const lines = meetings.reduce((n, m) => n + m.lines.length, 0)
  const insertSeconds = +((performance.now() - t0) / 1000).toFixed(1)

  const words = WORDS.map((word) => {
    const has = new Set(meetings.filter((m) => m.lines.some((l) => l.text.includes(word))).map((m) => idOf.get(m.id)))
    const ms = []
    let hits = []
    for (let i = 0; i < 5; i++) { const t = performance.now(); hits = store.search(word, LIMIT); ms.push(performance.now() - t) }
    return {
      word, linesWithIt: meetings.reduce((n, m) => n + m.lines.filter((l) => l.text.includes(word)).length, 0), meetingsWithIt: has.size,
      shouldShow: Math.min(LIMIT, has.size), shown: hits.length, shownAndHaveIt: hits.filter((h) => has.has(h.meetingId)).length, ms: +median(ms).toFixed(1),
    }
  })
  store.close()

  // For the record: the pair index that was tried and dropped (bench/cjk-search), timed on these real lines.
  const pairs = (run) => (run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)))
  const RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
  const grams = (text) => (text.match(RUNS) ?? []).map((r) => pairs(r).join(' ')).join(' x ')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, start_ms INTEGER NOT NULL, text TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX segments_meeting ON segments(meeting_id, start_ms);
    CREATE VIRTUAL TABLE segments_cjk USING fts5(grams);`)
  const ins = db.prepare('INSERT INTO segments (meeting_id, start_ms, text) VALUES (?, ?, ?)')
  db.exec('BEGIN'); for (const m of meetings) for (const l of m.lines) ins.run(idOf.get(m.id), l.startMs, l.text); db.exec('COMMIT')
  const size = () => Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size)
  const dataBytes = size()
  const t1 = performance.now()
  const idx = db.prepare('INSERT INTO segments_cjk(rowid, grams) VALUES (?, ?)')
  db.exec('BEGIN'); for (const r of db.prepare('SELECT id, text FROM segments').all()) idx.run(r.id, grams(r.text)); db.exec('COMMIT')
  const buildMs = Math.round(performance.now() - t1), indexBytes = size() - dataBytes
  const timed = (fn) => { const ms = []; for (let i = 0; i < 15; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t) } return +median(ms).toFixed(2) }
  const pairIndex = {
    buildMs, indexMB: +(indexBytes / 1048576).toFixed(1), dataMB: +(dataBytes / 1048576).toFixed(1),
    queries: WORDS.map((word) => {
      const ps = pairs(word)
      const scan = db.prepare(`SELECT meeting_id, text FROM segments WHERE hidden = 0 AND ${ps.map(() => 'instr(text, ?) > 0').join(' AND ')} ORDER BY meeting_id, start_ms LIMIT 500`)
      const indexed = db.prepare('SELECT s.meeting_id AS meeting_id, s.text AS text FROM segments_cjk JOIN segments s ON s.id = segments_cjk.rowid WHERE segments_cjk MATCH ? AND s.hidden = 0 ORDER BY segments_cjk.rank LIMIT 500')
      return { word, readEveryLineMs: timed(() => scan.all(...ps)), pairIndexMs: timed(() => indexed.all(`"${ps.join(' ')}"`)) }
    }),
  }
  db.close()

  const out = [`${meetings.length} meetings, ${lines.toLocaleString('en')} lines, written to the Store in ${insertSeconds} s`, '',
    '| word | lines with it | meetings with it | should show (of 30) | shown | shown and have it | search (ms) |', '|---|---|---|---|---|---|---|',
    ...words.map((w) => `| ${w.word} | ${w.linesWithIt.toLocaleString('en')} | ${w.meetingsWithIt} | ${w.shouldShow} | ${w.shown} | ${w.shownAndHaveIt} | ${w.ms} |`), '',
    `pair index on the same lines: built in ${pairIndex.buildMs} ms, ${pairIndex.indexMB} MB for ${pairIndex.dataMB} MB of lines`, '',
    '| word | read every line (ms) | pair index (ms) |', '|---|---|---|',
    ...pairIndex.queries.map((q) => `| ${q.word} | ${q.readEveryLineMs} | ${q.pairIndexMs} |`)]
  console.log(out.join('\n'))
  writeFileSync(join(here, 'results-search.json'), JSON.stringify({ node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10), meetings: meetings.length, lines, insertSeconds, limit: LIMIT, words, pairIndex }, null, 1) + '\n')
})
