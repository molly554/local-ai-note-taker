import { InsufficientMemoryError } from 'node-llama-cpp'
import { serial } from './serial'
import type { createLlm } from './llm'
import type { EngineEvent, EngineRequest } from '../shared/engine-protocol'

type Llm = Pick<ReturnType<typeof createLlm>, 'load' | 'unload' | 'count' | 'chat' | 'preload' | 'embed' | 'unloadEmbed' | 'probe'>

/**
 * The worker's requests, one at a time (a load disposes the context a chat is using). A chat's stop switch exists
 * from the moment the request arrives, so stopping one still waiting its turn means it never starts.
 */
export function createHandler(llm: Llm, send: (e: EngineEvent) => void) {
  const aborts = new Map<number, AbortController>()
  const run = serial()

  const handle = async (req: EngineRequest): Promise<unknown> => {
    if (req.type === 'load') return llm.load(req.modelPath, req.contextSize, req.minContext)
    if (req.type === 'unload') return llm.unload()
    if (req.type === 'count') return llm.count(req.texts)
    if (req.type === 'embed') return llm.embed(req.modelPath, req.texts)
    if (req.type === 'unload-embed') return llm.unloadEmbed()
    if (req.type === 'probe') return llm.probe()
    if (req.type === 'chat') {
      const signal = aborts.get(req.id)?.signal
      if (signal?.aborted) return ''
      return llm.chat(req, (text, thought) => send({ id: req.id, type: 'token', text, ...(thought ? { thought } : {}) }), signal, (text) => send({ id: req.id, type: 'timing', text }))
    }
    if (req.type === 'preload') {
      const signal = aborts.get(req.id)?.signal
      if (signal?.aborted) return 0
      return llm.preload(req.messages, signal, (text) => send({ id: req.id, type: 'timing', text }))
    }
  }

  return async (req: EngineRequest) => {
    if (req.type === 'chat' || req.type === 'preload') aborts.set(req.id, new AbortController())
    try {
      const result = req.type === 'abort' ? aborts.get(req.targetId)?.abort() : await run(() => handle(req))
      send({ id: req.id, type: 'result', data: result ?? null })
    } catch (err) {
      send({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err), code: err instanceof InsufficientMemoryError ? 'OOM' : undefined })
    } finally {
      if (req.type === 'chat' || req.type === 'preload') aborts.delete(req.id)
    }
  }
}
