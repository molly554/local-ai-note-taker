// Chinese search: reading every line (before) against the pair index (after), on generated transcripts.
//   node bench/cjk-search/run.mjs            (Node 22.13+; nothing to install)
// The data is made here from a fixed seed, so every run searches the same lines. The two queries are the ones in
// app/src/main/store.ts (search) before and after cjkIndex.ts; this times the SQL, not the app around it.
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const pairs = (run) => (run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)))
const grams = (text) => (text.match(RUNS) ?? []).map((r) => pairs(r).join(' ')).join(' x ')
const cjkMatch = (q) => (q.match(RUNS) ?? []).filter((r) => r.length >= 2).map((r) => `"${pairs(r).join(' ')}"`).join(' ')

// a small seeded generator (mulberry32)
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const WHO = ['我们', '产品组', '设计这边', '销售团队', '客户', '研发', '市场部', '运营', '老板', '合作方']
const DO = ['讨论了', '确认了', '需要重新评估', '准备推进', '暂时搁置', '下周同步', '已经完成', '还在等', '打算调整', '提出了']
const WHAT = ['上线时间', '发布计划', '招聘名额', '预算方案', '定价策略', '用户反馈', '安装签名', '数据看板', '培训安排', '供应商报价', '合同条款', '测试进度', '营销素材', '客服流程', '性能问题']
const TAIL = ['没有异议', '下周再看', '需要老板拍板', '风险不大', '先小范围试', '月底前给结论', '跟进人待定', '成本偏高', '优先级靠前', '等客户回复']
function makeLines(n, seed) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)]
  const out = []
  for (let i = 0; i < n; i++) {
    let text = `${pick(WHO)}${pick(DO)}${pick(WHAT)}，${pick(TAIL)}`
    if (r() < 0.3) text += `，${pick(WHO)}${pick(DO)}${pick(WHAT)}`
    if (r() < 0.0002) text += '，另外续约的事要提前谈' // a rare word
    out.push({ meeting: `m${String(Math.floor(i / 200)).padStart(5, '0')}`, start: (i % 200) * 6000, text })
  }
  return out
}

const QUERIES = [['common word', '发布'], ['rare word', '续约'], ['four-letter phrase', '定价策略'], ['two words', '预算 签名'], ['not in the library', '火箭']]
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const time = (fn, runs = 15) => { const ms = []; let rows = 0; for (let i = 0; i < runs; i++) { const t = performance.now(); rows = fn(); ms.push(performance.now() - t) } return { ms: median(ms), rows } }

const results = []
for (const n of [10_000, 50_000, 200_000]) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, start_ms INTEGER NOT NULL, text TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX segments_meeting ON segments(meeting_id, start_ms);
    CREATE VIRTUAL TABLE segments_cjk USING fts5(grams);`)
  const lines = makeLines(n, 20261111)
  const ins = db.prepare('INSERT INTO segments (meeting_id, start_ms, text) VALUES (?, ?, ?)')
  db.exec('BEGIN'); for (const l of lines) ins.run(l.meeting, l.start, l.text); db.exec('COMMIT')
  const size = () => Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size)
  const before = size()
  const t0 = performance.now()
  const idx = db.prepare('INSERT INTO segments_cjk(rowid, grams) VALUES (?, ?)')
  db.exec('BEGIN'); for (const r of db.prepare('SELECT id, text FROM segments').all()) idx.run(r.id, grams(r.text)); db.exec('COMMIT')
  const buildMs = performance.now() - t0, indexBytes = size() - before
  for (const [name, q] of QUERIES) {
    const ps = [...new Set((q.match(RUNS) ?? []).flatMap(pairs))]
    const scan = db.prepare(`SELECT meeting_id, text FROM segments WHERE hidden = 0 AND ${ps.map(() => 'instr(text, ?) > 0').join(' AND ')} ORDER BY meeting_id, start_ms LIMIT 500`)
    const indexed = db.prepare('SELECT s.meeting_id AS meeting_id, s.text AS text FROM segments_cjk JOIN segments s ON s.id = segments_cjk.rowid WHERE segments_cjk MATCH ? AND s.hidden = 0 ORDER BY segments_cjk.rank LIMIT 500')
    const a = time(() => scan.all(...ps).length), b = time(() => indexed.all(cjkMatch(q)).length)
    const total = db.prepare(`SELECT count(*) AS n FROM segments WHERE ${ps.map(() => 'instr(text, ?) > 0').join(' AND ')}`).get(...ps).n
    results.push({ lines: n, query: name, q, matchingLines: Number(total), scanMs: +a.ms.toFixed(2), scanRows: a.rows, indexMs: +b.ms.toFixed(2), indexRows: b.rows, buildMs: Math.round(buildMs), indexMB: +(indexBytes / 1048576).toFixed(1), dataMB: +(before / 1048576).toFixed(1) })
  }
  db.close()
}
console.log('| lines | query | lines that match | read every line (ms) | pair index (ms) | index build (ms) | index size (MB) | data size (MB) |')
console.log('|---|---|---|---|---|---|---|---|')
for (const r of results) console.log(`| ${r.lines.toLocaleString('en')} | ${r.query}: ${r.q} | ${r.matchingLines.toLocaleString('en')} | ${r.scanMs} | ${r.indexMs} | ${r.buildMs} | ${r.indexMB} | ${r.dataMB} |`)
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results.json'), JSON.stringify({ node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10), results }, null, 1) + '\n')
