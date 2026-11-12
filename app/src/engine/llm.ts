import { getLlama, Gemma4ChatWrapper, LlamaChatSession, type ChatHistoryItem, type Llama, type LlamaContext, type LlamaContextSequence, type LlamaEmbeddingContext, type LlamaModel } from 'node-llama-cpp'
import { cleanAnswer, streamCleaner } from './control'
import { samplingFor } from './sampling'
import { holds } from './prefix'
import { engineThreads } from './threads'
import { availableParallelism } from 'node:os'
import type { EngineMessage } from '../shared/engine-protocol'

const toHistory = (messages: EngineMessage[]): ChatHistoryItem[] =>
  messages.map((m) => (m.role === 'system' ? { type: 'system', text: m.content } : m.role === 'user' ? { type: 'user', text: m.content } : { type: 'model', response: [m.content] }))

/**
 * The notes model itself: load, count tokens, write. Used by the worker process. Callers run one thing at a time (the worker's serial()).
 */
export function createLlm() {
  let llama: Llama | undefined
  let model: LlamaModel | undefined
  let context: LlamaContext | undefined
  /** One sequence for the model's whole life: a request that starts like the last one only reads what's new */
  let main: LlamaContextSequence | undefined
  /** the embedding model (meaning search across meetings): small, its own context, kept until let go */
  let embedder: { path: string; model: LlamaModel; context: LlamaEmbeddingContext } | undefined
  // YOGURT_ENGINE_GPU=off: the graphics card crashed the engine before, on Windows or Linux (src/main/engine.ts)
  const getL = async () => (llama ??= await getLlama(process.env.YOGURT_ENGINE_GPU === 'off' ? { gpu: false } : undefined))
  // Gemma's auto wrapper requests thinking; a zero token budget cuts it off instead of disabling it.
  const threads = (l: Llama) => { const n = engineThreads(process.platform, l.cpuMathCores, availableParallelism()); return n === undefined ? {} : { threads: n } }
  const chatWrapper = () => model?.fileInfo.metadata.general.architecture === 'gemma4' ? new Gemma4ChatWrapper({ reasoning: false }) : 'auto' as const

  const unload = async () => {
    main = undefined
    await context?.dispose(); context = undefined
    await model?.dispose(); model = undefined
  }

  const unloadEmbed = async () => {
    const e = embedder
    embedder = undefined
    await e?.context.dispose()
    await e?.model.dispose()
  }

  return {
    /** the graphics this engine can use: a Mac never asks */
    async probe() {
      const l = await getL()
      const v = await l.getVramState()
      const GB = 1e9
      return { gpuType: l.gpu, vramTotalGB: v.total / GB, unifiedGB: v.unifiedSize / GB, gpuNames: await l.getGpuDeviceNames() }
    },
    unload,
    unloadEmbed,
    /** each text's embedding, as the model gives it (main cuts it to length and normalises it) */
    async embed(modelPath: string, texts: string[]): Promise<number[][]> {
      if (embedder?.path !== modelPath) {
        await unloadEmbed()
        const l = await getL()
        const model = await l.loadModel({ modelPath })
        // a chunk is about 300 words: well inside the model's own 2,048 tokens
        embedder = { path: modelPath, model, context: await model.createEmbeddingContext({ contextSize: Math.min(2048, model.trainContextSize), ...threads(l) }) }
      }
      const out: number[][] = []
      for (const t of texts) out.push(Array.from((await embedder.context.getEmbeddingFor(t)).vector))
      return out
    },
    /** gpu: what it runs on (cuda, vulkan, metal, or false: the processor alone), for the log */
    async load(modelPath: string, contextSize: number, minContext: number): Promise<{ contextSize: number; gpu: string | false }> {
      await unload()
      const l = await getL()
      model = await l.loadModel({ modelPath })
      context = await model.createContext({ contextSize: { min: Math.min(minContext, contextSize), max: contextSize }, ...threads(l) })
      main = context.getSequence()
      // the first evaluation pages the weights in from disk: pay it here, not on the first word of the notes
      await main.evaluateWithoutGeneratingNewTokens(model.tokenize('Hello'))
      return { contextSize: context.contextSize, gpu: l.gpu }
    },
    count(texts: string[]): number[] {
      if (!model) throw new Error('No model loaded')
      return texts.map((t) => model!.tokenize(t).length)
    },
    /**
     * Reads a conversation in without answering: the last (user) message only as far as its text goes, as the start
     * of a prompt to come. A chat that starts the same way then only reads the rest. The read itself can't be
     * stopped once it started (node-llama-cpp evaluates it whole): callers keep each one small.
     */
    async preload(messages: EngineMessage[], signal?: AbortSignal, onTiming?: (text: string) => void): Promise<number> {
      if (!main) throw new Error('No model loaded')
      const last = messages.at(-1)
      if (!last || last.role !== 'user') throw new Error('Last message must be from the user')
      // already read (or more): reading it again would drop what comes after it
      if (messages.length === 1 && holds(main.contextTokens, model!.tokenize(last.content))) return 0
      const t0 = performance.now(), read0 = main.tokenMeter.usedInputTokens
      // the same session set-up as chat(), or what is read would not match
      const session = new LlamaChatSession({ contextSequence: main, chatWrapper: chatWrapper() })
      session.setChatHistory(toHistory(messages.slice(0, -1)))
      try {
        await session.preloadPrompt(last.content, { signal })
        return main.tokenMeter.usedInputTokens - read0
      } finally {
        session.dispose({ disposeSequence: false })
        onTiming?.(`read ahead ${(main.tokenMeter.usedInputTokens - read0).toLocaleString('en-US')} tok ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      }
    },
    /** the answer, without control tags; onToken gets it as it is written (thought: thinking, never shown) */
    async chat(req: { messages: EngineMessage[]; maxTokens?: number; thoughtBudget: number; temperature?: number }, onToken: (text: string, thought?: boolean) => void, signal?: AbortSignal, onTiming?: (text: string) => void): Promise<string> {
      if (!main || !model) throw new Error('No model loaded')
      const last = req.messages.at(-1)
      if (!last || last.role !== 'user') throw new Error('Last message must be from the user')
      const t0 = performance.now(), read0 = main.tokenMeter.usedInputTokens
      let first: number | undefined, made = 0, text = ''
      const clean = streamCleaner((t) => onToken(t, true))
      const session = new LlamaChatSession({ contextSequence: main, chatWrapper: chatWrapper() })
      session.setChatHistory(toHistory(req.messages.slice(0, -1)))
      try {
        await session.prompt(last.content, {
          ...samplingFor(model.fileInfo.metadata.general.architecture),
          // a fixed answer wanted (who is who): colder than the family's sampling, so the same meeting names the same people each time
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          signal, stopOnAbortSignal: true, budgets: { thoughtTokens: req.thoughtBudget },
          ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
          onToken: (t) => { made += t.length; first ??= performance.now() },
          onTextChunk: (chunk) => { text += chunk; const out = clean.push(chunk); if (out) onToken(out) },
        })
        const rest = clean.end()
        if (rest) onToken(rest)
        return cleanAnswer(text)
      } finally {
        // the sequence stays: it holds what was just read
        session.dispose({ disposeSequence: false })
        const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
        onTiming?.(`read ${(main.tokenMeter.usedInputTokens - read0).toLocaleString('en-US')} tok ${s((first ?? performance.now()) - t0)}, wrote ${made.toLocaleString('en-US')} tok ${s(performance.now() - (first ?? t0))}`)
      }
    },
  }
}
