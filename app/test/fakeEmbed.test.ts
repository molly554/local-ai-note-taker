import { describe, expect, it } from 'vitest'
import { FakeEngine } from '../src/main/notes/fake'

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

describe('the fake embedding model', () => {
  it('gives the same text the same vector, and texts sharing words closer ones than texts that share none', async () => {
    const e = new FakeEngine()
    const [q, near, far, again] = await e.embed('/fake', [
      'task: search result | query: when is the launch?',
      'title: none | text: Bo Park: The launch is on Tuesday.',
      'title: none | text: We went hiking at the weekend.',
      'task: search result | query: when is the launch?',
    ])
    expect(q).toHaveLength(768)
    expect(again).toEqual(q)
    expect(dot(q, near)).toBeGreaterThan(dot(q, far))
  })
})

describe('the fake notes model, asked across meetings', () => {
  it('cites the first sources by number and title, or says nothing was found', async () => {
    const e = new FakeEngine()
    process.env.YOGURT_FAKE_LLM_MS = '0'
    const ask = (content: string) => e.chat({ messages: [{ role: 'user', content }] }, () => {})
    const sources = '…<sources>\nMeeting: Pricing call · Tuesday\n[1] 0:04 into the meeting\nx\n\n[2] 0:09 into the meeting\nz\n\nMeeting: Weekly sync · Monday\n[3] the meeting notes\ny\n</sources>\n<question>\n'
    // like a small model: every part of a meeting cited after its line
    expect(await ask(sources + 'q\n</question>'))
      .toBe('Here is what came up:\n- In **Pricing call**, it was discussed [1][2].\n- In **Weekly sync**, it was discussed [3].')
    // and with nothing to say, every source cited anyway
    expect(await ask(sources + 'What about politics?\n</question>')).toBe('Nothing in your meetings is about that [1][2][3].')
    expect(await ask('<sources>\nNo meetings matched this question.\n</sources>\n<question>\nq\n</question>')).toBe("I couldn't find that in your meetings.")
  })
})
