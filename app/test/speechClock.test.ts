import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Apple's SpeechAnalyzer stops for good on a buffer that starts before the last one ended. The helper places each
// buffer on its timeline in samples; this runs that placement (yogurt-audio speech-clock RATE: "ms frames" lines in,
// one start sample per line out).
const bin = join(import.meta.dirname, '../resources/bin/yogurt-audio')
const run = existsSync(bin) && process.platform === 'darwin'

function place(rate: number, feeds: [number, number][]): number[] {
  const input = feeds.map(([ms, n]) => `${ms} ${n}`).join('\n') + '\n'
  return execFileSync(bin, ['speech-clock', String(rate)], { input }).toString().trim().split('\n').map(Number)
}

describe.skipIf(!run)("where each buffer goes on Apple speech's timeline", () => {
  it('back to back for buffers with fractions of a ms (what a 48 kHz tap gives at 16 kHz)', () => {
    // 170 and 171 sample buffers, at the meeting times the track gives them
    const feeds: [number, number][] = []
    let s = 0
    for (let i = 0; i < 200; i++) { const n = i % 3 === 0 ? 171 : 170; feeds.push([1234.5678 + s / 16, n]); s += n }
    const at = place(16000, feeds)
    expect(at[0]).toBe(Math.round(1234.5678 * 16))
    for (let i = 1; i < at.length; i++) expect(at[i]).toBe(at[i - 1] + feeds[i - 1][1])
  })
  it('never earlier than where the last one ended, even when the meeting clock steps back', () => {
    const at = place(16000, [[1000, 1600], [1050, 1600], [900, 1600]])
    expect(at).toEqual([16000, 17600, 19200])
  })
  it('jumps ahead after a pause or a rebuilt device, so words keep their meeting time', () => {
    const at = place(16000, [[1000, 1600], [5000, 1600]])
    expect(at).toEqual([16000, 80000])
  })
})
