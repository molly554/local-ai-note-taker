import { describe, expect, it } from 'vitest'
import { createHandler } from '../src/engine/handler'
import { holds } from '../src/engine/prefix'
import type { EngineEvent, EngineRequest } from '../src/shared/engine-protocol'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** the worker's request handling over a stand-in model */
function rig() {
  const sent: EngineEvent[] = []
  const started: number[] = []
  const finishers = new Map<number, () => void>()
  const llm = {
    load: async () => ({ contextSize: 1 }), unload: async () => {}, count: (xs: string[]) => xs.map((x) => x.length),
    probe: async () => ({ gpuType: 'vulkan', vramTotalGB: 8, unifiedGB: 0, gpuNames: ['Radeon'] }),
    chat: (req: { messages: Array<{ content: string }> }, _onToken: unknown, signal?: AbortSignal) => {
      const n = Number(req.messages.at(-1)!.content)
      started.push(n)
      return new Promise<string>((r) => { finishers.set(n, () => r(`done ${n}`)); signal?.addEventListener('abort', () => r('stopped')) })
    },
  }
  const preloaded: string[] = []
  const handle = createHandler({ ...llm, preload: async (messages: Array<{ content: string }>) => { preloaded.push(messages.at(-1)!.content); return 7 } } as never, (e) => sent.push(e))
  const chat = (id: number): EngineRequest => ({ id, type: 'chat', messages: [{ role: 'user', content: String(id) }], thoughtBudget: 0 })
  return { sent, started, finishers, handle, chat, preloaded }
}

describe('engine worker requests', () => {
  it('says what graphics it can use (Windows and Linux ask before picking a model)', async () => {
    const r = rig()
    await r.handle({ id: 5, type: 'probe' })
    expect(r.sent).toContainEqual({ id: 5, type: 'result', data: { gpuType: 'vulkan', vramTotalGB: 8, unifiedGB: 0, gpuNames: ['Radeon'] } })
  })
  it('a chat stopped while it waits behind another never starts', async () => {
    const r = rig()
    void r.handle(r.chat(1))
    void r.handle(r.chat(2))
    await tick()
    expect(r.started).toEqual([1])
    void r.handle({ id: 3, type: 'abort', targetId: 2 })
    await tick()
    r.finishers.get(1)!()
    await tick(); await tick()
    expect(r.started).toEqual([1])
    expect(r.sent.filter((e) => e.type === 'result').map((e) => e.id).sort()).toEqual([1, 2, 3])
  })
  it('a running chat can be stopped', async () => {
    const r = rig()
    void r.handle(r.chat(1))
    await tick()
    void r.handle({ id: 2, type: 'abort', targetId: 1 })
    await tick(); await tick()
    expect(r.sent).toContainEqual({ id: 1, type: 'result', data: 'stopped' })
  })
  it('a read ahead runs in turn, and one stopped while it waits never starts', async () => {
    const r = rig()
    void r.handle(r.chat(1))
    void r.handle({ id: 2, type: 'preload', messages: [{ role: 'user', content: 'first' }] })
    void r.handle({ id: 3, type: 'preload', messages: [{ role: 'user', content: 'second' }] })
    await tick()
    expect(r.preloaded).toEqual([])
    void r.handle({ id: 4, type: 'abort', targetId: 3 })
    await tick()
    r.finishers.get(1)!()
    await tick(); await tick(); await tick()
    expect(r.preloaded).toEqual(['first'])
    expect(r.sent).toContainEqual({ id: 2, type: 'result', data: 7 })
  })
})

describe('holds: does the model already hold this text', () => {
  const ctx = [1, 2, 3, ...Array.from({ length: 30 }, (_, i) => 100 + i), 999]
  it('yes when the text follows the chat format\'s first tokens, whatever its first and last two tokens became', () => {
    expect(holds(ctx, [7, ...Array.from({ length: 20 }, (_, i) => 101 + i), 8, 9])).toBe(true)
  })
  it('no when a token in the middle differs, or the text runs past what it holds', () => {
    const t = [7, ...Array.from({ length: 20 }, (_, i) => 101 + i), 8, 9]
    t[10] = 5
    expect(holds(ctx, t)).toBe(false)
    expect(holds(ctx, [7, ...Array.from({ length: 40 }, (_, i) => 101 + i), 8, 9])).toBe(false)
  })

  it('embeds texts with the embedding model, one request at a time with the rest (a load must not pull it away mid-way)', async () => {
    const sent: EngineEvent[] = []
    const order: string[] = []
    const handle = createHandler({
      load: async () => { order.push('load'); return { contextSize: 1 } }, unload: async () => {}, count: () => [], chat: async () => '', preload: async () => 0,
      embed: async (path: string, texts: string[]) => { order.push(`embed ${path}`); await tick(); return texts.map((t) => [t.length, 0]) },
      unloadEmbed: async () => { order.push('unload embed') },
    } as never, (e) => sent.push(e))
    const a = handle({ id: 1, type: 'embed', modelPath: '/m/e.gguf', texts: ['ab', 'abcd'] })
    const b = handle({ id: 2, type: 'load', modelPath: '/m/n.gguf', contextSize: 1, minContext: 1 })
    const c = handle({ id: 3, type: 'unload-embed' })
    await Promise.all([a, b, c])
    expect(order).toEqual(['embed /m/e.gguf', 'load', 'unload embed'])
    expect(sent.find((e) => e.id === 1)).toEqual({ id: 1, type: 'result', data: [[2, 0], [4, 0]] })
  })
})
