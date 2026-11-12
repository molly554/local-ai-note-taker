// Could EmbeddingGemma's tokenizer stand in for the Gemma 4 notes models'? (It is the small file fetch.mjs --models
// brings.) It compares the vocabularies in the files' headers: how many tokens, and a hash of them in order.
//   node bench/real-meetings/vocab.mjs     after fetch.mjs --models and pnpm install
// The answer was no, they differ, which is why headers.mjs fetches the Gemma 4 files' own headers. A Gemma 4 file is
// read from its header-only copy when headers.mjs has made one, otherwise from its catalogue address (header only).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readGgufFileInfo } from 'node-llama-cpp'
import { data, here } from './meetings.mjs'

const catalog = JSON.parse(readFileSync(join(here, '..', '..', 'catalog', 'catalog.json'), 'utf8'))
const find = (o, id) => (Array.isArray(o) ? o.map((x) => find(x, id)).find(Boolean) : o && typeof o === 'object' ? (o.id === id ? o : find(Object.values(o), id)) : undefined)
const gemma4 = (id) => { const url = find(catalog, id).builds[0].url, copy = join(data, 'models', url.split('/').pop().replace(/\.gguf$/, '.header-only.gguf')); return existsSync(copy) ? copy : url }

async function vocabulary(name, where) {
  try {
    const t = (await readGgufFileInfo(where, { readTensorInfo: false })).metadata.tokenizer.ggml
    return { name, kind: t.model, tokens: t.tokens.length, sha256: createHash('sha256').update(t.tokens.join('\n')).digest('hex') }
  } catch (e) { return { name, error: String(e?.message ?? e).slice(0, 200) } }
}

const results = [
  await vocabulary('EmbeddingGemma 300M', join(data, 'models', 'embeddinggemma-300M-Q8_0.gguf')),
  await vocabulary('Gemma 4 E2B', gemma4('gemma-4-e2b')),
  await vocabulary('Gemma 4 E4B (the starter notes model)', gemma4('gemma-4-e4b')),
]
for (const r of results) console.log(r.error ? `${r.name}: could not be read (${r.error})` : `${r.name}: ${r.kind}, ${r.tokens.toLocaleString('en')} tokens, ${r.sha256.slice(0, 16)}${r === results[0] ? '' : r.sha256 === results[0].sha256 ? '  the same vocabulary as EmbeddingGemma' : '  not the same vocabulary as EmbeddingGemma'}`)
writeFileSync(join(here, 'results-vocab.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), results }, null, 1) + '\n')
process.exit(0)
