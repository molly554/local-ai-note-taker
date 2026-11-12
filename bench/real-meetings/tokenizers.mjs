// The tokenizers of two of the app's notes models, loaded without their weights: the starter model (Gemma 4 E4B, from
// a header-only copy of its file, see headers.mjs) and the smallest one (Qwen3 1.7B, see fetch.mjs --models).
// Counting is what the app's engine does: model.tokenize(text).length.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getLlama } from 'node-llama-cpp'
import { data } from './meetings.mjs'

const FILES = [
  { name: 'Gemma 4 E4B', file: 'gemma-4-E4B_q4_0-it.header-only.gguf' },
  { name: 'Qwen3 1.7B', file: 'Qwen3-1.7B-Q8_0.gguf' },
]

export async function realTokenizers() {
  const llama = await getLlama({ gpu: false })
  const out = []
  for (const { name, file } of FILES) {
    const modelPath = join(data, 'models', file)
    if (!existsSync(modelPath)) { console.error(`No ${file} (fetch.mjs --models, then headers.mjs): ${name} is left out.`); continue }
    const model = await llama.loadModel({ modelPath, vocabOnly: true })
    // the same turn is counted for every build and context: remembered until reset()
    let seen = new Map()
    out.push({
      name,
      count(s) { let n = seen.get(s); if (n === undefined) { n = model.tokenize(s).length; if (s.length < 200_000) seen.set(s, n) } return n },
      reset() { seen = new Map() },
    })
  }
  return out
}
