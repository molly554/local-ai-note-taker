// Fetches the public meeting transcripts the checks in this folder run on (text only, about 28 MB).
//   node bench/real-meetings/fetch.mjs
// Nothing fetched is kept in the repository: data/ is ignored. Each source is pinned to a revision, and
// data/manifest.json records every file's address, size and SHA-256. Licences and what each set is: README.md.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
