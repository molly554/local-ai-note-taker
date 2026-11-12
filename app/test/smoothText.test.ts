import { describe, expect, it } from 'vitest'
import { TextSmoother } from '../src/shared/smoothText'

/** animation frames every 16 ms from `from` to `to` */
const frames = (s: TextSmoother, from: number, to: number) => { for (let t = from; t <= to; t += 16) s.tick(t) }

describe('smooth streaming text', () => {
  it('reveals new text over a short time instead of all at once', () => {
    const s = new TextSmoother('', true)
    s.update('Hello there, this is the answer.', true, 0)
    expect(s.shown).toBe('')
    s.tick(16)
    expect(s.shown.length).toBeGreaterThan(0)
    expect(s.shown.length).toBeLessThan(32)
    expect('Hello there, this is the answer.'.startsWith(s.shown)).toBe(true)
    // a short backlog goes at most 5 ms a character, so 32 characters take 160 ms
    s.tick(160)
    expect(s.shown).toBe('Hello there, this is the answer.')
    expect(s.settled).toBe(true)
  })

  it('catches up with a fast model: a big backlog goes faster, most of it within 250 ms', () => {
    const s = new TextSmoother('', true)
    const big = 'word '.repeat(2000)
    s.update(big, true, 0)
    frames(s, 16, 256)
    expect(s.shown.length).toBeGreaterThan(big.length * 0.6)
    frames(s, 272, 2000)
    expect(s.shown).toBe(big)
  })

  it('keeps up as chunks arrive: never further behind than the drain time', () => {
    const s = new TextSmoother('', true)
    let text = '', worst = 0
    // about 540 characters a second, faster than any notes model here
    for (let t = 0; t <= 3000; t += 16) {
      if (t % 48 === 0) { text += 'more words arriving fast. '; s.update(text, true, t) }
      s.tick(t)
      worst = Math.max(worst, text.length - s.shown.length)
    }
    // a quarter of a second of text at most
    expect(worst).toBeLessThan(160)
    frames(s, 3016, 3600)
    expect(s.shown).toBe(text)
  })

  it('time spent waiting for the next chunk is not saved up into a jump', () => {
    const s = new TextSmoother('', true)
    s.update('abc', true, 0)
    s.tick(100)
    expect(s.shown).toBe('abc')
    // nothing new for two seconds, then a long chunk: it still unrolls, not all at once
    const next = 'abc' + 'x'.repeat(200)
    s.update(next, true, 2100)
    s.tick(2116)
    expect(s.shown.length).toBeLessThan(next.length)
  })

  it('shows the full text at once when streaming ends or is stopped', () => {
    const s = new TextSmoother('', true)
    s.update('The whole answer, finished.', true, 0)
    s.tick(10)
    expect(s.shown).not.toBe('The whole answer, finished.')
    s.update('The whole answer, finished.', false, 12)
    expect(s.shown).toBe('The whole answer, finished.')
    expect(s.settled).toBe(true)
  })

  it('with reduced motion the text appears at once', () => {
    const s = new TextSmoother('', true)
    s.update('No animation please.', true, 0, true)
    expect(s.shown).toBe('No animation please.')
  })

  it('text that is not streaming starts shown in full', () => {
    expect(new TextSmoother('Saved notes', false).shown).toBe('Saved notes')
  })

  it('a corrected reading keeps the words that still match and reveals the rest', () => {
    const s = new TextSmoother('', true)
    s.update('we should ship on', true, 0)
    s.tick(500)
    s.update('we should shift the date', true, 500)
    expect(s.shown).toBe('we should shi')
    s.tick(800)
    expect(s.shown).toBe('we should shift the date')
  })

  it('never cuts an emoji or other two-part character in half', () => {
    const s = new TextSmoother('', true)
    const text = 'a\u{1F600}b'
    s.update(text, true, 0)
    for (let t = 1; t < 20; t++) {
      s.tick(t)
      const last = s.shown.charCodeAt(s.shown.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(s.shown).toBe(text)
  })
})
