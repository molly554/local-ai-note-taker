import { utilityProcess, type UtilityProcess } from 'electron'
import type { EngineEvent, EngineMessage, EngineRequest } from '../shared/engine-protocol'
import type { GpuProbe } from './hardware'
import { PRODUCT } from '../shared/brand'

export class InsufficientMemoryError extends Error { name = 'InsufficientMemoryError' }
/** Windows and Linux: the graphics card took too long (or crashed), so the engine starts again without it; try once more */
export class GraphicsGaveUpError extends Error { name = 'GraphicsGaveUpError' }

/**
 * Off a Mac, how long a step may take before the graphics card counts as stuck (a hang, not a crash: some drivers do).
 * Loading includes reading the weights from disk; the first word includes reading a long meeting in.
 */
export const WATCH = { probeMs: 90_000, loadMs: 5 * 60_000, firstTokenMs: 5 * 60_000, cpuLoadMs: 15 * 60_000, cpuFirstTokenMs: 30 * 60_000 }
type Limits = typeof WATCH

export type ChatRequest = { messages: EngineMessage[]; maxTokens?: number; thoughtBudget?: number; /** instead of the family's sampling temperature */ temperature?: number }

export interface Engine {
  load(modelPath: string, contextSize: number, minContext: number): Promise<{ contextSize: number }>
  unload(): Promise<void>
  count(texts: string[]): Promise<number[]>
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal): Promise<string>
  /** reads messages in without answering, the last one as the start of a prompt to come (tokens read) */
  preload(messages: EngineMessage[], signal?: AbortSignal): Promise<number>
  /** each text as the embedding model's vector (loaded on first use, kept until unloadEmbed) */
  embed(modelPath: string, texts: string[]): Promise<number[][]>
  unloadEmbed(): Promise<void>
  /** the engine process died (not on dispose): what it had loaded is gone */
  onExit(cb: () => void): void
  dispose(): void
}

/** load: checking the graphics or loading a model, where a graphics driver can crash the engine */
type Pending = { resolve(v: unknown): void; reject(e: Error): void; onToken?: (t: string) => void; load?: boolean; model?: boolean; timer?: NodeJS.Timeout }
type Req = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

/** The notes model's worker (src/engine/worker.ts) in an Electron utility process, started on first use */
export class UtilityEngine implements Engine {
  private proc: UtilityProcess | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private exitListeners: (() => void)[] = []
  private disposed = false
  /**
   * Windows and Linux (gpuFallback): some graphics drivers crash the engine as it checks the card or loads a model.
   * After a crash like that it starts without the graphics card: slower, but it works. A Mac never does.
   */
  private cpuOnly = false
  /** a model loaded fine in this process, so a later crash isn't the graphics card failing to start */
  private loaded = false

  private limits: Limits

  constructor(private workerPath: string, private opts: { gpuFallback?: boolean } & Partial<Limits> = {}) {
    this.limits = { ...WATCH, ...opts }
  }

  /**
   * Windows and Linux only: a step that takes far too long. On the graphics card the engine is stopped and the next
   * try runs without it (GraphicsGaveUpError); without it the step fails plainly, so nothing waits forever.
   */
  private watch(id: number, step: string, gpuMs: number, cpuMs: number) {
    const p = this.pending.get(id)
    if (!p || !this.opts.gpuFallback) return
    clearTimeout(p.timer)
    const onCard = !this.cpuOnly, ms = onCard ? gpuMs : cpuMs
    p.timer = setTimeout(() => {
      if (this.pending.get(id) !== p) return
      if (onCard) this.cpuOnly = true
      console.warn(`notes engine: ${step} took over ${Math.round(ms / 1000)} s ${onCard ? 'on the graphics card; starting it again without it' : 'without the graphics card; giving up'}`)
      this.drop(() => onCard ? new GraphicsGaveUpError(`The graphics card took too long (${step})`) : new Error(`The notes model took too long (${step})`))
    }, ms)
  }

  /** stops a stuck engine at once: what it had loaded is gone (onExit), everything waiting on it fails */
  private drop(error: () => Error) {
    const proc = this.proc
    this.proc = undefined
    const waiting = [...this.pending.values()]
    this.pending.clear()
    proc?.kill()
    for (const cb of this.exitListeners) cb()
    for (const p of waiting) { clearTimeout(p.timer); p.reject(error()) }
  }

  private ensure(): UtilityProcess {
    if (this.proc) return this.proc
    const proc = utilityProcess.fork(this.workerPath, [], { serviceName: `${PRODUCT} notes`, ...(this.cpuOnly ? { env: { ...process.env, YOGURT_ENGINE_GPU: 'off' } } : {}) })
    this.loaded = false
    proc.on('message', (e: EngineEvent) => {
      const p = this.pending.get(e.id)
      if (!p) return
      // thinking is never shown: only the answer streams. Any token (thinking too) means the model is writing.
      if (e.type === 'token') { if (p.timer) { clearTimeout(p.timer); p.timer = undefined; console.info('NOTES', 'first words') } if (!e.thought) p.onToken?.(e.text); return }
      if (e.type === 'timing') { console.info('TIMING', e.text); return }
      this.pending.delete(e.id)
      clearTimeout(p.timer)
      if (e.type === 'result' && p.model) this.loaded = true
      if (e.type === 'result') p.resolve(e.data)
      else p.reject(e.code === 'OOM' ? new InsufficientMemoryError(e.message) : new Error(e.message))
    })
    proc.on('exit', (code: number) => {
      // stopped as stuck (drop): already dealt with
      if (this.proc !== proc) return
      this.proc = undefined
      const starting = !!this.opts.gpuFallback && !this.cpuOnly && !this.loaded && [...this.pending.values()].some((p) => p.load)
      if (starting) this.cpuOnly = true
      if (!this.disposed) console.error(`notes engine stopped (code ${code})${starting ? '; starting it again without the graphics card' : ''}`)
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(starting ? new GraphicsGaveUpError('The notes engine stopped while starting on the graphics card') : new Error('The notes engine stopped unexpectedly')) }
      this.pending.clear()
      if (!this.disposed) for (const cb of this.exitListeners) cb()
    })
    return (this.proc = proc)
  }

  private call<T>(req: Req, onToken?: (t: string) => void): { id: number; done: Promise<T> } {
    const id = this.nextId++
    const model = req.type === 'load', load = model || req.type === 'probe'
    const done = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onToken, ...(load ? { load, model } : {}) }))
    this.ensure().postMessage({ ...req, id })
    return { id, done }
  }

  /** the graphics the engine can use (Windows and Linux, before picking a model) */
  probe() {
    const { id, done } = this.call<GpuProbe>({ type: 'probe' })
    this.watch(id, 'checking the graphics', this.limits.probeMs, this.limits.probeMs)
    return done
  }
  load(modelPath: string, contextSize: number, minContext: number) {
    console.info('NOTES', `loading the notes model ${modelPath.split(/[\\/]/).pop()}${this.opts.gpuFallback ? (this.cpuOnly ? ' without the graphics card' : ' (graphics card allowed)') : ''}`)
    const { id, done } = this.call<{ contextSize: number; gpu?: string | false }>({ type: 'load', modelPath, contextSize, minContext })
    this.watch(id, 'loading the model', this.limits.loadMs, this.limits.cpuLoadMs)
    return done.then((r) => { console.info('NOTES', `notes model loaded: context ${r.contextSize}, graphics ${r.gpu === undefined ? 'unknown' : r.gpu || 'none'}`); return r })
  }
  async unload() { if (this.proc) await this.call({ type: 'unload' }).done }
  count(texts: string[]) { return this.call<number[]>({ type: 'count', texts }).done }
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new Error('Stopped'))
    const { id, done } = this.call<string>({ type: 'chat', messages: req.messages, thoughtBudget: req.thoughtBudget ?? 0, ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }, onToken)
    // the first word: reading the prompt in comes before it
    this.watch(id, 'the first word', this.limits.firstTokenMs, this.limits.cpuFirstTokenMs)
    signal?.addEventListener('abort', () => { this.call({ type: 'abort', targetId: id }).done.catch(() => {}) }, { once: true })
    return done
  }
  preload(messages: EngineMessage[], signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(0)
    const { id, done } = this.call<number>({ type: 'preload', messages })
    signal?.addEventListener('abort', () => { this.call({ type: 'abort', targetId: id }).done.catch(() => {}) }, { once: true })
    return done
  }
  embed(modelPath: string, texts: string[]) { return this.call<number[][]>({ type: 'embed', modelPath, texts }).done }
  async unloadEmbed() { if (this.proc) await this.call({ type: 'unload-embed' }).done }
  onExit(cb: () => void) { this.exitListeners.push(cb) }
  dispose() { this.disposed = true; this.proc?.kill() }
}
