import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Gemma4ChatWrapper, type LlamaChatSessionOptions } from 'node-llama-cpp'
import { createLlm } from '../src/engine/llm'

const fake = vi.hoisted(() => ({ architecture: 'gemma4', sessions: [] as unknown[] }))
vi.mock('node-llama-cpp', async (original) => {
  const actual = await original<typeof import('node-llama-cpp')>()
  const sequence = { contextTokens: [], tokenMeter: { usedInputTokens: 0 }, evaluateWithoutGeneratingNewTokens: async () => {} }
  return {
    ...actual,
    getLlama: async () => ({ loadModel: async () => ({
      fileInfo: { metadata: { general: { architecture: fake.architecture } } },
      tokenize: () => [], dispose: async () => {},
      createContext: async () => ({ contextSize: 8192, getSequence: () => sequence, dispose: async () => {} }),
    }) }),
    LlamaChatSession: class {
      constructor(options: LlamaChatSessionOptions) { fake.sessions.push(options) }
      setChatHistory() {}
      async preloadPrompt() {}
      async prompt() { return '' }
      dispose() {}
    },
  }
})

beforeEach(() => { fake.sessions.length = 0 })

describe('model prompt wrapper', () => {
  it.each(['gemma4', 'qwen3', 'gpt-oss'])('preload and answers use the same format for %s', async (architecture) => {
    fake.architecture = architecture
    const llm = createLlm()
    await llm.load('fixture.gguf', 8192, 8192)
    const messages = [{ role: 'user' as const, content: 'Synthetic transcript.' }]
    await llm.preload(messages)
    await llm.chat({ messages, thoughtBudget: 0 }, () => {})
    expect(fake.sessions).toHaveLength(2)
    for (const { chatWrapper } of fake.sessions as LlamaChatSessionOptions[]) {
      if (architecture === 'gemma4') {
        expect(chatWrapper).toBeInstanceOf(Gemma4ChatWrapper)
        const wrapper = chatWrapper as Gemma4ChatWrapper
        expect(wrapper.reasoning).toBe(false)
        const context = wrapper.generateContextState({ chatHistory: [{ type: 'user', text: 'Synthetic transcript.' }, { type: 'model', response: [] }] }).contextText.toString()
        expect(context).toContain('<|turn>user\nSynthetic transcript.')
        expect(context).not.toContain('<|think|>')
      } else expect(chatWrapper ?? 'auto').toBe('auto')
    }
    await llm.unload()
  })
})
