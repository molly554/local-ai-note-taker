import { CONTEXT, MIN_CONTEXT, type EngineMessage } from '../../shared/engine-protocol'
import { GraphicsGaveUpError, type Engine } from '../engine'
import type { Llm } from './enhance'
import { readInSteps } from './readAhead'

/** an earlier prompt and answer, as the conversation they were */
const before = (pairs: string[] = []): EngineMessage[] => pairs.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }))

/**
 * The notes model as the notes need it: loaded on first use (the best one downloaded: the bigger one once it is in),
 * one sequence for its whole life, let go when the queue says so. It remembers what the sequence starts with, so a
 * read ahead only sends what is new.
 */
export function createNotesModel(o: { engine: Engine; modelPath: () => string | undefined }) {
  let loaded: { path: string; contextSize: number } | undefined
  let loading: Promise<{ path: string; contextSize: number }> | undefined
  /** the text the model's sequence starts with (the first message of what it last read): what a read ahead builds on */
  let held = ''
  o.engine.onExit(() => { loaded = undefined; loading = undefined; held = '' })

  const ensure = async (): Promise<{ path: string; contextSize: number }> => {
    const path = o.modelPath()
    if (!path) throw new Error('No notes model yet')
    if (loaded?.path === path) return loaded
    held = ''
    const t0 = performance.now()
    loading ??= o.engine.load(path, CONTEXT, MIN_CONTEXT).then((r) => {
      console.info('TIMING', `load ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      return (loaded = { path, contextSize: r.contextSize })
    }).finally(() => { loading = undefined })
    return loading
  }
  /** Windows and Linux: the graphics card gave up (stuck or crashed while starting); the engine now runs without it, once more */
  const again = <T>(run: () => Promise<T>, ok = () => true): Promise<T> => run().catch((e) => {
    if (!(e instanceof GraphicsGaveUpError) || !ok()) throw e
    loaded = undefined; loading = undefined; held = ''
    return run()
  })
  const load = () => again(ensure)

  return {
    /** the model, loaded; a stopped job's signal stops what it is writing */
    async llm(signal?: AbortSignal): Promise<Llm> {
      const m = await load()
      return {
        contextSize: m.contextSize,
        count: (texts) => o.engine.count(texts),
        chat: (prompt, onToken, opts) => {
          const messages: EngineMessage[] = [...before(opts?.before), { role: 'user', content: prompt }]
          // not known while it runs; the worker skips what it already holds, so knowing less only costs a check
          held = ''
          let wrote = false
          const ask = () => o.engine.chat({ messages, ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}), ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}) }, (t) => { wrote = true; onToken(t) }, signal)
          // no word came on the graphics card: loaded again without it, and asked again (nothing was shown yet)
          let first = true
          return again(async () => { if (!first) await ensure(); first = false; return ask() }, () => !wrote && !signal?.aborted)
            .then((r) => { if (!signal?.aborted) held = messages[0].content; return r })
        },
        readAhead: async (text, stop) => {
          const s = stop ?? signal
          held = await readInSteps(held, text, async (part) => { await o.engine.preload([{ role: 'user', content: part }], s) }, s)
        },
      }
    },
    async unload() {
      if (!loaded && !loading) return
      await loading?.catch(() => {})
      loaded = undefined
      held = ''
      await o.engine.unload().catch((e) => console.error('letting the notes model go failed', e))
    },
    loaded: () => loaded?.path,
    /** the next llm() loads the model first (it isn't loaded, or a better one landed) */
    needsLoad: () => { const path = o.modelPath(); return !!path && loaded?.path !== path },
  }
}
export type NotesModel = ReturnType<typeof createNotesModel>
