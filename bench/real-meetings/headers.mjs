// The tokenizer of a model file without its weights: for the app's Gemma 4 notes models, which are 3 to 5 GB each.
//   node bench/real-meetings/headers.mjs     after fetch.mjs --models and pnpm install
// A model file starts with a header: its settings, its vocabulary and the list of its tensors. Counting tokens needs
// nothing else. So only the header is fetched (some MB) from the file's catalogue address, and the rest of the file is
// left empty: the copy has the real file's length, so the loader's size check passes, but holds no weights (on NTFS it
// is marked sparse and takes no room). Such a copy can count tokens and nothing more; its name says "header-only".
// The method is checked first on a file that is here whole: a header-only copy of EmbeddingGemma must count every
// line of a real meeting the same as the whole file does.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLlama, readGgufFileInfo } from 'node-llama-cpp'
import { aishell4, data, here } from './meetings.mjs'

const models = join(data, 'models')
const catalog = JSON.parse(readFileSync(join(here, '..', '..', 'catalog', 'catalog.json'), 'utf8'))
const find = (o, id) => (Array.isArray(o) ? o.map((x) => find(x, id)).find(Boolean) : o && typeof o === 'object' ? (o.id === id ? o : find(Object.values(o), id)) : undefined)
const UA = { 'User-Agent': 'real-meetings-bench' }

/** where the tensors' own bytes start: everything before is the header (a margin is added by the callers) */
async function headerBytes(where) {
  const info = await readGgufFileInfo(where, { readTensorInfo: true })
  return info.totalMetadataSize + info.totalTensorInfoSize
}
function emptyRest(path, header, size) {
  writeFileSync(path, header)
  try { execFileSync('fsutil', ['sparse', 'setflag', path], { stdio: 'ignore' }) } catch { /* not NTFS, or not allowed: the file then takes its full length on disk */ }
  truncateSync(path, size)
}

const llama = await getLlama({ gpu: false })
const counts = async (modelPath, texts) => { const m = await llama.loadModel({ modelPath, vocabOnly: true }); const out = texts.map((t) => m.tokenize(t).length); await m.dispose(); return out }
const texts = aishell4()[0].lines.map((l) => l.text)
const out = { date: new Date().toISOString().slice(0, 10), check: null, files: [] }

// 1. the check: whole file against its header-only copy
{
  const whole = join(models, 'embeddinggemma-300M-Q8_0.gguf'), copy = join(models, 'embeddinggemma-300M-Q8_0.header-only.gguf')
  const n = await headerBytes(whole) + 1048576, size = statSync(whole).size
  const fd = openSync(whole, 'r'), header = Buffer.alloc(n)
  readSync(fd, header, 0, n, 0); closeSync(fd)
  emptyRest(copy, header, size)
  const a = await counts(whole, texts), b = await counts(copy, texts)
  out.check = { file: 'embeddinggemma-300M-Q8_0.gguf', headerMB: +(n / 1048576).toFixed(1), fileMB: +(size / 1048576).toFixed(1), lines: texts.length, linesCountedTheSame: a.filter((x, i) => x === b[i]).length }
  console.log(`check: header ${out.check.headerMB} MB of ${out.check.fileMB} MB; ${out.check.linesCountedTheSame} of ${out.check.lines} lines counted the same by the whole file and the header-only copy`)
  if (out.check.linesCountedTheSame !== texts.length) { writeFileSync(join(here, 'results-headers.json'), JSON.stringify(out, null, 1) + '\n'); console.error('The copy counts differently: stopping.'); process.exit(1) }
}

// 2. the Gemma 4 notes models, header only
for (const id of ['gemma-4-e4b', 'gemma-4-e2b']) {
  const url = find(catalog, id).builds[0].url, name = url.split('/').pop().replace(/\.gguf$/, '.header-only.gguf'), path = join(models, name)
  const row = { id, url, file: name }
  try {
    if (!existsSync(path)) {
      const n = await headerBytes(url) + 1048576
      const r = await fetch(url, { headers: { ...UA, Range: `bytes=0-${n - 1}` }, signal: AbortSignal.timeout(600_000) })
      if (r.status !== 206) throw new Error(`${r.status} ${r.statusText}`)
      const size = Number(r.headers.get('content-range')?.split('/')[1]), header = Buffer.from(await r.arrayBuffer())
      if (!size || header.length !== n) throw new Error('header came short')
      emptyRest(path, header, size)
      row.headerMB = +(n / 1048576).toFixed(1); row.fileGB = +(size / 1e9).toFixed(2)
    }
    row.tokensInFirstMeeting = (await counts(path, texts)).reduce((a, b) => a + b, 0)
    console.log(`${id}: ${name}${row.headerMB ? `, header ${row.headerMB} MB of ${row.fileGB} GB` : ''}; first AISHELL-4 meeting is ${row.tokensInFirstMeeting.toLocaleString('en')} tokens`)
  } catch (e) { row.error = String(e?.message ?? e).slice(0, 300); console.log(`${id}: failed (${row.error})`) }
  out.files.push(row)
}
writeFileSync(join(here, 'results-headers.json'), JSON.stringify(out, null, 1) + '\n')
process.exit(0)
