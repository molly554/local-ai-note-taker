import { describe, expect, it } from 'vitest'
import { afterFinal, joinWords, replaceWords, wordsOf } from '../src/shared/liveWords'

const said = (ws: ReturnType<typeof wordsOf>) => joinWords(ws)

describe('wordsOf', () => {
  it("keeps whisper's own word times, with punctuation joined to the word before", () => {
    const ws = wordsOf({ startMs: 1000, endMs: 3000, text: 'Okay, so this', words: [
      { text: ' Okay', startMs: 1000, endMs: 1400 }, { text: ',', startMs: 1400, endMs: 1500 }, { text: ' so', startMs: 1500, endMs: 1800 }, { text: ' this', startMs: 1800, endMs: 2200 },
    ] })
    expect(said(ws)).toBe('Okay, so this')
    expect(ws.map((w) => w.rough)).toEqual([undefined, undefined, undefined, undefined])
    expect(ws[2].startMs).toBe(1500)
  })
  it('spreads the words over the reading when it gives no word times (marked rough)', () => {
    const ws = wordsOf({ startMs: 0, endMs: 1000, text: 'aa bb' })
    expect(said(ws)).toBe('aa bb')
    expect(ws.every((w) => w.rough)).toBe(true)
    expect(ws[0].endMs).toBeLessThanOrEqual(ws[1].startMs)
    expect(ws[1].endMs).toBe(1000)
  })
  it("a run of several words with one time (Apple's volatile reading) is spread too", () => {
    const ws = wordsOf({ startMs: 0, endMs: 2000, text: 'So I can', words: [{ text: ' So I can', startMs: 0, endMs: 2000 }] })
    expect(said(ws)).toBe('So I can')
    expect(ws).toHaveLength(3)
    expect(ws.every((w) => w.rough)).toBe(true)
  })
  it("leaves out whisper's special tokens and empty words", () => {
    expect(said(wordsOf({ startMs: 0, endMs: 1000, text: 'hi', words: [{ text: '[_BEG_]', startMs: 0, endMs: 0 }, { text: ' hi', startMs: 0, endMs: 500 }, { text: ' ', startMs: 500, endMs: 600 }] }))).toBe('hi')
  })
})

describe('replaceWords', () => {
  it('a new reading of a stretch takes the place of the old one there, and leaves the words before it', () => {
    const before = wordsOf({ startMs: 0, endMs: 2000, text: 'first chunk words', words: [{ text: ' first', startMs: 0, endMs: 500 }, { text: ' chunk', startMs: 500, endMs: 1000 }, { text: ' words', startMs: 1000, endMs: 1500 }] })
    const open = wordsOf({ startMs: 3000, endMs: 4000, text: 'we shud', words: [{ text: ' we', startMs: 3000, endMs: 3400 }, { text: ' shud', startMs: 3400, endMs: 3900 }] })
    let ws = replaceWords(replaceWords([], before, () => false), open, (w) => w.startMs >= 3000)
    expect(said(ws)).toBe('first chunk words we shud')
    const again = wordsOf({ startMs: 3000, endMs: 5000, text: 'we should move', words: [{ text: ' we', startMs: 3000, endMs: 3400 }, { text: ' should', startMs: 3400, endMs: 3900 }, { text: ' move', startMs: 3900, endMs: 4500 }] })
    ws = replaceWords(ws, again, (w) => w.startMs >= 3000)
    expect(said(ws)).toBe('first chunk words we should move')
  })
  it('a reading of only the last seconds of a long sentence keeps the words heard before them', () => {
    const early = wordsOf({ startMs: 0, endMs: 9000, text: 'one two three four five six', words: ['one', 'two', 'three', 'four', 'five', 'six'].map((t, i) => ({ text: ' ' + t, startMs: i * 1500, endMs: i * 1500 + 1000 })) })
    let ws = replaceWords([], early, () => false)
    // the quick reading covers 1000 ms onward only
    const tail = wordsOf({ startMs: 1000, endMs: 10_000, text: 'two three four five six seven', words: ['two', 'three', 'four', 'five', 'six', 'seven'].map((t, i) => ({ text: ' ' + t, startMs: (i + 1) * 1500, endMs: (i + 1) * 1500 + 1000 })) })
    ws = replaceWords(ws, tail, (w) => (w.startMs + w.endMs) / 2 >= 1000)
    expect(said(ws)).toBe('one two three four five six seven')
  })
})

describe('afterFinal', () => {
  it('a final line takes away every timed word before its end, never one after', () => {
    const ws = wordsOf({ startMs: 0, endMs: 4000, text: 'we should move it', words: [{ text: ' we', startMs: 0, endMs: 500 }, { text: ' should', startMs: 500, endMs: 1000 }, { text: ' move', startMs: 2500, endMs: 3000 }, { text: ' it', startMs: 3000, endMs: 3500 }] })
    expect(said(afterFinal(ws, { endMs: 1200, text: 'We should' }))).toBe('move it')
  })
  it("rough words (no times of their own) that say the final's last words go with it, whatever their guessed times", () => {
    // Apple's volatile reading began earlier than whisper's line; its guessed times would cut it in the wrong place
    const ws = wordsOf({ startMs: 0, endMs: 3000, text: 'the launch plan for next week? Great' })
    expect(said(afterFinal(ws, { endMs: 1000, text: 'Can we go over the launch plan for next week?' }))).toBe('Great')
  })
  it('rough words that run on past the final stay, even when the guessed times say otherwise', () => {
    const ws = wordsOf({ startMs: 0, endMs: 1000, text: 'so I can take a little break and they will all be' })
    expect(said(afterFinal(ws, { endMs: 900, text: 'So I can take little breaks' }))).toBe('and they will all be')
  })
  it('rough words that never match go by time, keeping a little slack for the guess', () => {
    const ws = wordsOf({ startMs: 0, endMs: 1800, text: 'aa bb cc dd ee ff' })
    expect(said(afterFinal(ws, { endMs: 1500, text: 'something else entirely' }))).toBe('dd ee ff')
  })
  it("a reading that starts long before its words (Apple's starts where its last final ended) puts them at its end, at a speaking pace", () => {
    // whisper's line of the earlier sentence ends at 10.3 s; the next sentence began at 13.3 s
    const ws = wordsOf({ startMs: 8700, endMs: 15_000, text: 'She will send a draft by' })
    expect(ws[0].startMs).toBeGreaterThan(12_000)
    expect(said(afterFinal(ws, { endMs: 10_300, text: 'and the email goes out on Wednesday morning.' }))).toBe('She will send a draft by')
  })
  it('a final with no words (nothing heard, or dropped) still takes away what was before it', () => {
    const ws = wordsOf({ startMs: 0, endMs: 1000, text: 'umm', words: [{ text: ' umm', startMs: 0, endMs: 500 }] })
    expect(afterFinal(ws, { endMs: 1000, text: '' })).toEqual([])
  })
})
