import { describe, expect, it, vi } from 'vitest'
import { createNotesModel } from '../src/main/notes/model'
import { GraphicsGaveUpError, type Engine } from '../src/main/engine'

/** an engine whose graphics card gives up the first `fails` times a step is tried */
function rig(o: { loadFails?: number; chatFails?: number; chatError?: Error }) {
  let loadFails = o.loadFails ?? 0, chatFails = o.chatFails ?? 0
  const exits: (() => void)[] = []
  const calls: string[] = []
  const engine: Engine = {
    load: vi.fn(async () => { calls.push('load'); if (loadFails-- > 0) { exits.forEach((f) => f()); throw new GraphicsGaveUpError('stuck') } return { contextSize: 8192 } }),
    unload: async () => {}, count: async (t) => t.map(() => 1), preload: async () => 0, embed: async () => [], unloadEmbed: async () => {}, dispose: () => {},
    onExit: (cb) => { exits.push(cb) },
    chat: vi.fn(async (_r, onToken) => {
      calls.push('chat')
      if (chatFails-- > 0) { exits.forEach((f) => f()); throw o.chatError ?? new GraphicsGaveUpError('no first word') }
      onToken('Hi'); return 'Hi'
    }),
  }
  return { calls, model: createNotesModel({ engine, modelPath: () => '/m.gguf' }) }
}

describe('the notes model when the graphics card gives up (Windows and Linux)', () => {
  it('a load that gave up on the graphics card is tried once more, without it', async () => {
    const r = rig({ loadFails: 1 })
    await expect(r.model.llm()).resolves.toMatchObject({ contextSize: 8192 })
    expect(r.calls).toEqual(['load', 'load'])
  })

  it('a second give-up is not tried again: the notes fail and can be tried again by hand', async () => {
    const r = rig({ loadFails: 2 })
    await expect(r.model.llm()).rejects.toBeInstanceOf(GraphicsGaveUpError)
    expect(r.calls).toEqual(['load', 'load'])
  })

  it('no first word on the graphics card: loaded again without it, and the same prompt asked once more', async () => {
    const r = rig({ chatFails: 1 })
    const llm = await r.model.llm()
    const words: string[] = []
    await expect(llm.chat('the prompt', (t) => words.push(t))).resolves.toBe('Hi')
    expect(r.calls).toEqual(['load', 'chat', 'load', 'chat'])
    expect(words).toEqual(['Hi'])
  })

  it('any other failure is not retried', async () => {
    const r = rig({ chatFails: 1, chatError: new Error('Stopped') })
    const llm = await r.model.llm()
    await expect(llm.chat('the prompt', () => {})).rejects.toThrow('Stopped')
    expect(r.calls).toEqual(['load', 'chat'])
  })
})
