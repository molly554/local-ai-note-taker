import { describe, expect, it } from 'vitest'
import { cutTurn, roughTokens, splitForContext } from '../src/main/notes/enhance'

/** as enhance() counts: a whole transcript line has the tokenizer's own count, anything cut from it is a guess */
const counter = (line: string, real: number) => (s: string) => (s === line ? real : roughTokens(s))
/** what was said, without who said it or any spacing */
const said = (pieces: string[], who: string) => pieces.join('\n').split(who).join('').replace(/\s+/g, '')

describe('one person talking for a whole meeting (a lecture, a room on one mic)', () => {
  const zh = (n: number, stop: string) => 'You: ' + Array.from({ length: n }, (_, i) => `我们今天讨论第${i + 1}个议题主要是关于产品发布的时间安排和定价策略${stop}`).join(' ')
  const MAX = 12_000

  it('Chinese without punctuation is cut into parts that fit, losing nothing', () => {
    const turn = zh(3000, '')
    const count = counter(turn, 70_000)
    const pieces = splitForContext(turn, MAX, count)
    expect(pieces.length).toBeGreaterThan(5)
    for (const p of pieces) { expect(count(p)).toBeLessThanOrEqual(MAX); expect(p.startsWith('You: ')).toBe(true) }
    expect(said(pieces, 'You: ')).toBe(said([turn], 'You: '))
  })

  it('Chinese with punctuation gets parts sized by its letters, not by a third of them', () => {
    const turn = zh(3000, '。')
    const count = counter(turn, 70_000)
    const pieces = splitForContext(turn, MAX, count)
    for (const p of pieces) expect(count(p)).toBeLessThanOrEqual(MAX)
    // a third of the characters let a part hold 36,000 of them; counted by letter it holds under 14,000
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThan(14_000)
    expect(pieces.every((p) => p.endsWith('。'))).toBe(true)
  })

  it('a run with no spaces at all is cut between characters', () => {
    const turn = 'Them: ' + '字'.repeat(50_000)
    const count = counter(turn, 50_000)
    const pieces = cutTurn(turn, MAX, count)
    expect(pieces.length).toBeGreaterThanOrEqual(5)
    for (const p of pieces) { expect(count(p)).toBeLessThanOrEqual(MAX); expect(p.startsWith('Them: ')).toBe(true) }
    expect(said(pieces, 'Them: ').length).toBe(50_000)
  })

  it('English without punctuation is cut between words', () => {
    const turn = 'You: ' + Array.from({ length: 3000 }, (_, i) => `today we cover topic ${i + 1} which is mostly about the launch schedule and the pricing plan`).join(' ')
    const count = counter(turn, 60_000)
    const pieces = splitForContext(turn, MAX, count)
    expect(pieces.length).toBeGreaterThan(3)
    for (const p of pieces) { expect(count(p)).toBeLessThanOrEqual(MAX); expect(/\bpla$|\bschedul$/.test(p)).toBe(false) }
    expect(said(pieces, 'You: ')).toBe(said([turn], 'You: '))
  })

  it('English with punctuation still cuts only between sentences', () => {
    const turn = 'You: ' + Array.from({ length: 3000 }, (_, i) => `Today we cover topic ${i + 1} about the launch schedule.`).join(' ')
    const pieces = splitForContext(turn, MAX, counter(turn, 40_000))
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.endsWith('.'))).toBe(true)
  })

  it('a mark standing on its own between sentences is kept (transcripts written by hand have "the ? ? You know")', () => {
    const turn = 'You: ' + Array.from({ length: 2000 }, (_, i) => `So that is topic ${i + 1} . . And the ? ? Well, what I mean ... is this !`).join(' ')
    const pieces = splitForContext(turn, MAX, counter(turn, 40_000))
    expect(pieces.length).toBeGreaterThan(1)
    expect(said(pieces, 'You: ')).toBe(said([turn], 'You: '))
  })
})

describe('a Chinese meeting of many short turns', () => {
  it('is not passed on whole because a third of its characters looked small enough', () => {
    // 500 turns of about 30 letters: some 17,000 tokens by the letter, 6,500 by a third of the characters
    const lines = Array.from({ length: 500 }, (_, i) => `${i % 2 ? 'Them' : 'You'}: 我们今天讨论第${i + 1}个议题主要是关于产品发布的时间安排和定价`)
    const known = new Map(lines.map((l) => [l, roughTokens(l)]))
    const count = (s: string) => known.get(s) ?? roughTokens(s)
    const pieces = splitForContext(lines.join('\n'), 7000, count)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) expect(p.split('\n').reduce((n, l) => n + count(l) + 1, 0)).toBeLessThanOrEqual(7000)
    expect(pieces.join('\n')).toBe(lines.join('\n'))
  })
})

describe('roughTokens', () => {
  it('counts a Chinese, Japanese or Korean letter as a token and other text as a third of a token a character', () => {
    expect(roughTokens('abcdef')).toBe(2)
    expect(roughTokens('发布计划')).toBe(4)
    expect(roughTokens('発表の計画')).toBe(5)
    expect(roughTokens('출시 계획')).toBe(5)
    expect(roughTokens('发布 plan')).toBe(2 + 2)
  })
})
