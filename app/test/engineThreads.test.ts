import { expect, it } from 'vitest'
import { engineThreads } from '../src/engine/threads'

it('a Mac keeps node-llama-cpp\'s own choice (nothing passed)', () => {
  expect(engineThreads('darwin', 8, 10)).toBeUndefined()
})

it('off a Mac never more threads than the computer has: node-llama-cpp asks for 4 at least without graphics, which crawls on 2 cores', () => {
  expect(engineThreads('win32', 1, 2)).toBe(1)
  expect(engineThreads('win32', 2, 2)).toBe(2)
  expect(engineThreads('linux', 4, 8)).toBe(4)
  expect(engineThreads('win32', 8, 4)).toBe(4)
  expect(engineThreads('win32', 0, 0)).toBe(1)
})
