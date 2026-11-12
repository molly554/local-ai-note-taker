import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** a stand-in utility process: records what it was sent and how it was started; answers only when told */
class Proc extends EventEmitter {
  sent: any[] = []
  killed = false
  constructor(public env?: Record<string, string | undefined>) { super() }
  postMessage(m: any) { this.sent.push(m) }
  kill() { if (this.killed) return true; this.killed = true; queueMicrotask(() => this.emit('exit', 1)); return true }
  answer(type: string, data: unknown = null) { const m = this.sent.find((x) => x.type === type); this.emit('message', { id: m.id, type: 'result', data }) }
  token(type: string, text: string) { const m = this.sent.find((x) => x.type === type); this.emit('message', { id: m.id, type: 'token', text }) }
}
const procs: Proc[] = []
vi.mock('electron', () => ({ utilityProcess: { fork: (_p: string, _a: string[], o: { env?: Record<string, string> }) => { const p = new Proc(o.env); procs.push(p); return p } } }))
const { UtilityEngine, GraphicsGaveUpError } = await import('../src/main/engine')

const limits = { probeMs: 1000, loadMs: 1000, firstTokenMs: 1000, cpuLoadMs: 5000, cpuFirstTokenMs: 5000 }
const chat = { messages: [{ role: 'user' as const, content: 'hi' }] }

beforeEach(() => { procs.length = 0; vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the notes engine off a Mac: a graphics card that hangs', () => {
  it('a model load that takes too long on the graphics card starts the engine again without it', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const load = e.load('m.gguf', 32768, 8192)
    const caught = load.catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await caught).toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(true)
    // the next load runs without the graphics card
    const again = e.load('m.gguf', 32768, 8192)
    expect(procs).toHaveLength(2)
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
    procs[1].answer('load', { contextSize: 32768 })
    await expect(again).resolves.toEqual({ contextSize: 32768 })
  })

  it('without the graphics card it waits longer, then gives up plainly (never an endless wait)', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    await vi.advanceTimersByTimeAsync(1001)
    const slow = e.load('m.gguf', 32768, 8192).catch((x) => x)
    await vi.advanceTimersByTimeAsync(4000)
    expect(procs[1].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    const err = await slow
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[1].killed).toBe(true)
  })

  it('no first word on the graphics card in time: the same fallback; a word in time keeps it', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const l = e.load('m.gguf', 32768, 8192); procs[0].answer('load', { contextSize: 32768 }); await l
    const words: string[] = []
    const ok = e.chat(chat, (t) => words.push(t))
    await vi.advanceTimersByTimeAsync(900)
    procs[0].token('chat', 'Hello')
    await vi.advanceTimersByTimeAsync(5000)
    procs[0].answer('chat', 'Hello')
    await expect(ok).resolves.toBe('Hello')
    expect(procs[0].killed).toBe(false)

    const stuck = e.chat(chat, () => {}).catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await stuck).toBeInstanceOf(GraphicsGaveUpError)
    expect(procs[0].killed).toBe(true)
  })

  it('a graphics check that hangs gives up on the card instead of holding setup', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const probe = e.probe().catch((x) => x)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await probe).toBeInstanceOf(GraphicsGaveUpError)
    void e.load('m.gguf', 32768, 8192).catch(() => {})
    expect(procs[1].env?.YOGURT_ENGINE_GPU).toBe('off')
  })

  it('tells the log which graphics the model loaded on', async () => {
    const e = new UtilityEngine('engine.js', { gpuFallback: true, ...limits })
    const l = e.load('C:\\models\\llm\\gemma.gguf', 32768, 8192)
    expect(console.info).toHaveBeenCalledWith('NOTES', expect.stringContaining('loading the notes model gemma.gguf'))
    procs[0].answer('load', { contextSize: 16384, gpu: 'vulkan' })
    await l
    expect(console.info).toHaveBeenCalledWith('NOTES', expect.stringContaining('vulkan'))
  })
})

describe('the notes engine on a Mac', () => {
  it('has no time limits: a slow load still finishes, nothing is restarted', async () => {
    const e = new UtilityEngine('engine.js')
    const load = e.load('m.gguf', 32768, 8192)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    procs[0].answer('load', { contextSize: 32768 })
    await expect(load).resolves.toEqual({ contextSize: 32768 })
    expect(procs).toHaveLength(1)
    expect(procs[0].killed).toBe(false)
  })
})
