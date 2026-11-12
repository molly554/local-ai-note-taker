// Fetches the public meeting transcripts the checks in this folder run on (text only, about 28 MB).
//   node bench/real-meetings/fetch.mjs            the transcripts
//   node bench/real-meetings/fetch.mjs --models   and two model files for real token counts (2.2 GB)
// Nothing fetched is kept in the repository: data/ is ignored. Each source is pinned to a revision, and
// data/manifest.json records every file's address, size and SHA-256. Licences and what each set is: README.md.
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const data = join(here, 'data')
const UA = { 'User-Agent': 'real-meetings-bench' }

const AISHELL4 = 'aada72727856313b19d4a030383c426364931dbf' // huggingface.co/datasets/AISHELL/AISHELL-4
const QMSUM = '83d7768c1f2b4dfeb091385d3dc7e239b8e5bb7e' // github.com/Yale-LILY/QMSum
const VCSUM = '8e51d72e4e6f3af4074fd5b260b6f6d2e75e86c7' // github.com/hahahawu/VCSum

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: UA })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return Buffer.from(await r.arrayBuffer())
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`)
      await new Promise((ok) => setTimeout(ok, 1500 * attempt))
    }
  }
}

/**
 * A big file, eight pieces at a time (one connection can be slow), each piece written where it belongs. The pieces
 * that arrived are noted beside the file, so a run that was stopped picks up where it left off.
 */
async function inPieces(url, path) {
  const first = await fetch(url, { headers: { ...UA, Range: 'bytes=0-0' } })
  const size = Number(first.headers.get('content-range')?.split('/')[1])
  await first.arrayBuffer()
  if (!size) throw new Error(`${url}: no size given`)
  const PIECE = 16 * 1048576, n = Math.ceil(size / PIECE), part = `${path}.part`, notes = `${path}.pieces.json`
  const done = new Set(existsSync(part) && existsSync(notes) ? JSON.parse(readFileSync(notes, 'utf8')) : [])
  const fd = openSync(part, done.size ? 'r+' : 'w')
  let next = 0
  const take = () => { while (next < n && done.has(next)) next++; return next < n ? next++ : -1 }
  const worker = async () => {
    for (let i = take(); i >= 0; i = take()) {
      const from = i * PIECE, to = Math.min(size, from + PIECE) - 1
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await fetch(url, { headers: { ...UA, Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(300_000) })
          if (r.status !== 206) throw new Error(`${r.status} ${r.statusText}`)
          const bytes = Buffer.from(await r.arrayBuffer())
          if (bytes.length !== to - from + 1) throw new Error('piece came short')
          writeSync(fd, bytes, 0, bytes.length, from)
          done.add(i)
          writeFileSync(notes, JSON.stringify([...done]))
          if (done.size % 8 === 0) console.error(`${path.split(/[\\/]/).pop()}: ${done.size} of ${n} pieces`)
          break
        } catch (e) {
          if (attempt >= 6) throw new Error(`${url}: ${e.message}`)
          await new Promise((ok) => setTimeout(ok, 2000 * attempt))
        }
      }
    }
  }
  try { await Promise.all(Array.from({ length: 8 }, worker)) } finally { closeSync(fd) }
  renameSync(part, path)
  rmSync(notes)
}

const wanted = []
// AISHELL-4, test set: one TextGrid a meeting (who said what, with times)
const listed = JSON.parse((await get(`https://huggingface.co/api/datasets/AISHELL/AISHELL-4/tree/${AISHELL4}/test/TextGrid`)).toString('utf8'))
for (const f of listed) {
  if (f.type === 'file' && f.path.endsWith('.TextGrid')) wanted.push({ set: 'aishell4', name: f.path.split('/').pop(), url: `https://huggingface.co/datasets/AISHELL/AISHELL-4/resolve/${AISHELL4}/${f.path}` })
}
// QMSum: the product meetings (from AMI) and the academic meetings (from ICSI). The committee meetings are left out
for (const domain of ['Product', 'Academic']) for (const split of ['train', 'val', 'test']) {
  wanted.push({ set: 'qmsum', name: `${domain}-${split}.jsonl`, url: `https://raw.githubusercontent.com/Yale-LILY/QMSum/${QMSUM}/data/${domain}/jsonl/${split}.jsonl` })
}
// VCSum: every transcript, and the whole-meeting summaries
for (const name of ['overall_context.txt', 'long_train.txt', 'long_dev.txt', 'long_test.txt']) {
  wanted.push({ set: 'vcsum', name, url: `https://raw.githubusercontent.com/hahahawu/VCSum/${VCSUM}/vcsum_data/${name}` })
}

const manifest = []
let total = 0
for (const w of wanted) {
  const dir = join(data, w.set), path = join(dir, w.name)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, await get(w.url))
  const bytes = readFileSync(path)
  total += bytes.length
  manifest.push({ set: w.set, file: w.name, url: w.url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
writeFileSync(join(data, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
const bySet = {}
for (const m of manifest) { bySet[m.set] ??= { files: 0, bytes: 0 }; bySet[m.set].files++; bySet[m.set].bytes += m.bytes }
for (const [set, s] of Object.entries(bySet)) console.log(`${set}: ${s.files} files, ${(s.bytes / 1048576).toFixed(1)} MB`)
console.log(`total: ${manifest.length} files, ${(total / 1048576).toFixed(1)} MB -> ${data}`)

// --models: the two model files the real token counts come from (2.2 GB), at the addresses and checksums in the app's
// own catalogue: the smallest notes model, and the embedding model, whose tokenizer is the Gemma family's.
if (process.argv.includes('--models')) {
  const catalog = JSON.parse(readFileSync(join(here, '..', '..', 'catalog', 'catalog.json'), 'utf8'))
  const find = (o, id) => (Array.isArray(o) ? o.map((x) => find(x, id)).find(Boolean) : o && typeof o === 'object' ? (o.id === id ? o : find(Object.values(o), id)) : undefined)
  const qwen = find(catalog, 'qwen3-1.7b').builds[0], gemma = find(catalog, 'embeddinggemma-300m-q8_0')
  for (const m of [{ url: gemma.url, sha256: gemma.sha256 }, { url: qwen.url, sha256: qwen.sha256 }]) {
    const dir = join(data, 'models'), name = m.url.split('/').pop(), path = join(dir, name)
    mkdirSync(dir, { recursive: true })
    if (!existsSync(path)) await inPieces(m.url, path)
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    const got = hash.digest('hex')
    if (got !== m.sha256) throw new Error(`${name}: SHA-256 is ${got}, the catalogue says ${m.sha256}`)
    console.log(`${name}: ${(statSync(path).size / 1073741824).toFixed(2)} GB, SHA-256 matches the catalogue`)
  }
}
