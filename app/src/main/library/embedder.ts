import type { Engine } from '../engine'
import { docText, queryText, toVector } from './vectors'

/** a chunk is about 300 words; anything longer is cut well inside the model's 2,048 tokens */
const MAX_CHARS = 6000

/**
 * The embedding model as the library needs it: through the notes model's worker (one thing at a time there), once it
 * is downloaded. model() names what made a vector (the model and the dims kept), so a new model means new vectors.
 */
export function createEmbedder(o: { engine: Pick<Engine, 'embed' | 'unloadEmbed'>; modelPath: () => string | undefined; id: string; dims: number }) {
  let used = false
  const run = async (texts: string[]) => {
    const path = o.modelPath()
    if (!path) return undefined
    used = true
    return (await o.engine.embed(path, texts.map((t) => t.slice(0, MAX_CHARS)))).map((v) => toVector(v, o.dims))
  }
  return {
    ready: () => !!o.modelPath(),
    model: () => `${o.id}@${o.dims}`,
    /** a question's vector; undefined before the model is in */
    query: async (q: string) => (await run([queryText(q)]))?.[0],
    /** pieces of meetings, each with its meeting's title */
    docs: (items: Array<{ title: string; text: string }>) => run(items.map((i) => docText(i.title, i.text))),
    /** let go with the notes model when the queue is idle (or a small Mac records) */
    async unload() { if (used) { used = false; await o.engine.unloadEmbed().catch((e) => console.error('letting the embedding model go failed', e)) } },
  }
}
export type Embedder = ReturnType<typeof createEmbedder>
