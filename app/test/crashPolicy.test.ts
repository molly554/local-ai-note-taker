import { describe, expect, it } from 'vitest'
import { createCrashPolicy } from '../src/main/crashPolicy'

const setup = (restartThrows = false) => {
  const calls: string[] = []
  const policy = createCrashPolicy({
    restart: () => { calls.push('restart'); if (restartThrows) throw new Error('no helper') },
    hiccup: () => calls.push('hiccup'),
    giveUp: () => calls.push('giveUp'),
  })
  return { policy, calls }
}

describe('crash policy', () => {
  it('a clean end does nothing', () => {
    const { policy, calls } = setup()
    expect(policy.ended({ crashed: false })).toBe('done')
    expect(calls).toEqual([])
  })
  it('the first crash restarts and shows the hiccup', () => {
    const { policy, calls } = setup()
    expect(policy.ended({ crashed: true })).toBe('restarted')
    expect(calls).toEqual(['restart', 'hiccup'])
  })
  it('a second crash stops the meeting', () => {
    const { policy, calls } = setup()
    policy.ended({ crashed: true })
    expect(policy.ended({ crashed: true })).toBe('stopped')
    expect(calls).toEqual(['restart', 'hiccup', 'giveUp'])
  })
  it('a restart that fails stops the meeting at once, with no hiccup', () => {
    const { policy, calls } = setup(true)
    expect(policy.ended({ crashed: true })).toBe('stopped')
    expect(calls).toEqual(['restart', 'giveUp'])
  })
})
