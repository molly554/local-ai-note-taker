import { describe, expect, it } from 'vitest'
import { cutTurn, enhance, partBudget, piecesOf, roughTokens, sentencesOf, splitForContext, transcriptText, type Llm } from '../src/main/notes/enhance'
import type { Segment } from '../src/main/store'

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

describe('a long turn after shorter ones', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length
  it('starts in what is left of the part being built, so no part is left half empty', () => {
    const short = Array.from({ length: 10 }, (_, i) => `You: short turn number ${i}.`)
    const long = `Them: ${Array.from({ length: 56 }, (_, i) => `Sentence number ${i} here.`).join(' ')}`
    const pieces = splitForContext([...short, long].join('\n'), 100, words)
    // the short turns take 60 of the first part's 100: the long turn's first nine sentences go in after them
    expect(pieces[0]).toContain('You: short turn number 9.\nThem: Sentence number 0 here.')
    expect(pieces.length).toBe(3)
    for (const p of pieces) { expect(words(p)).toBeLessThanOrEqual(100); expect(p.split('\n').every((l) => /^(You|Them): /.test(l))).toBe(true) }
    expect(pieces.join(' ').match(/Sentence number \d+ here\./g)).toEqual(Array.from({ length: 56 }, (_, i) => `Sentence number ${i} here.`))
  })

  it('but not when only a sliver is left: the turn then starts a part of its own', () => {
    const short = Array.from({ length: 15 }, (_, i) => `You: short turn number ${i}.`)
    const long = `Them: ${Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(' ')}`
    const pieces = splitForContext([...short, long].join('\n'), 100, words)
    // 90 of 100 taken: under a quarter of a part is left
    expect(pieces[0]).not.toContain('Them:')
    expect(pieces[1].startsWith('Them: Sentence number 0 here.')).toBe(true)
  })
})

describe('sentences and pieces', () => {
  it('sentencesOf gives who spoke and the sentences, every character in one of them', () => {
    const turn = 'Speaker A: First one. Second?  Third . . and more'
    const { who, sentences } = sentencesOf(turn)
    expect(who).toBe('Speaker A: ')
    expect(sentences).toEqual(['First one. ', 'Second?  ', 'Third . . ', 'and more'])
    expect(who + sentences.join('')).toBe(turn)
  })

  it('piecesOf cuts between words, and a word longer than a piece between characters', () => {
    const s = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const pieces = piecesOf(s)
    expect(pieces.join('')).toBe(s)
    for (const p of pieces) { expect(p.length).toBeLessThanOrEqual(400); expect(/^word\d+/.test(p)).toBe(true) }
    expect(piecesOf('字'.repeat(1000)).map((p) => p.length)).toEqual([400, 400, 200])
  })
})

describe('parts sized by the tokenizer, not by a guess', () => {
  // about what the app's tokenizers give on real meetings: 0.6 of a token a Chinese letter, a token every four other characters
  const tokens = (s: string) => { const c = s.match(/\p{Script=Han}/gu)?.length ?? 0; return Math.ceil(c * 0.6 + (s.length - c) / 4) }
  /** a room heard on one microphone: every line is "You", so the whole meeting is one turn */
  const room = (text: (i: number) => string): Segment[] => Array.from({ length: 2000 }, (_, i) => ({ id: i, meetingId: 'm', track: 'me' as const, startMs: i * 5000, endMs: i * 5000 + 5000, text: text(i), speaker: null }))
  async function read(segments: Segment[]) {
    const prompts: string[] = []
    const llm: Llm = {
      contextSize: 8192, count: async (xs) => xs.map(tokens),
      chat: async (prompt, _onToken, o) => { if (o?.summary) { prompts.push(prompt); return '### 议题\n- 要点' } return '## 摘要\n- **You:** 跟进' },
    }
    await enhance({ meeting: { title: '', attendees: [] }, mine: '', segments, language: 'zh' }, llm, () => {})
    const transcript = transcriptText(segments), budget = await partBudget(llm, 'Chinese')
    return { prompts, fewest: Math.ceil(tokens(transcript) / budget), byGuess: Math.ceil(roughTokens(transcript) / budget) }
  }

  it('a Chinese meeting on one microphone is read in about as few parts as hold it, and every part fits', async () => {
    const { prompts, fewest, byGuess } = await read(room((i) => `我们今天讨论第${i + 1}个议题主要是关于产品发布的时间安排和定价策略。`))
    expect(byGuess).toBeGreaterThan(fewest + 2)
    expect(prompts.length).toBeLessThanOrEqual(fewest + 1)
    for (const p of prompts) expect(tokens(p) + 700).toBeLessThanOrEqual(8192)
  })

  it('the same with no punctuation at all, as speech to text may leave it', async () => {
    const { prompts, fewest } = await read(room((i) => `我们今天讨论第${i + 1}个议题主要是关于产品发布的时间安排和定价策略`))
    expect(prompts.length).toBeLessThanOrEqual(fewest + 1)
    for (const p of prompts) expect(tokens(p) + 700).toBeLessThanOrEqual(8192)
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
