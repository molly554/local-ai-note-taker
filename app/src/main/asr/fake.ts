import type { Chunk } from './chunker'
import type { Line } from './transcribe'
import { fakePrompts } from '../fake'

/**
 * Fake mode: no whisper. What the e2e fixtures (meeting-me.wav, meeting-them.wav) say, picked by where in the meeting
 * the chunk starts (the chunker cuts them at 0.5 s and 10.5 s on me, 5.2 s and 13.3 s on them).
 * Word times match simulated Apple's settled readings; a pause can split a phrase into shorter chunks.
 */
const SAYS = {
  me: [
    { at: 500, end: 4000, text: 'Hi, thanks for joining. Can we go over the launch plan for next week?' },
    { at: 10_500, end: 12_400, text: 'Great. Who is writing the release notes?' },
  ],
  them: [
    { at: 5200, end: 8700, text: 'Sure. The site goes live on Tuesday, and the email goes out on Wednesday morning.' },
    { at: 13_300, end: 14_800, text: 'She will send a draft by Friday.' },
  ],
} as const

export async function fakeTranscribe(c: Chunk, o?: { partial?: boolean }, prompt = '', language?: string): Promise<Line[]> {
  fakePrompts.whisper.push(prompt)
  fakePrompts.languages.push(language ?? 'auto')
  const near = SAYS[c.track].reduce((a, b) => (Math.abs(b.at - c.startMs) < Math.abs(a.at - c.startMs) ? b : a))
  // a partial: the first words, about as many as have been said so far
  const words = near.text.split(' ')
  const endMs = c.startMs + Math.round((c.samples.length / 16000) * 1000)
  // Resumed fixture audio can have a meeting offset beyond the script; keep its existing nearest-phrase stand-in.
  const overlaps = c.startMs < near.end && endMs > near.at
  const text = o?.partial ? words.slice(0, Math.max(2, Math.min(words.length - 1, Math.round(words.length * (c.samples.length / 16000) / 5)))).join(' ')
    : !overlaps ? near.text : words.filter((_, i) => { const at = near.at + (i + 0.5) / words.length * (near.end - near.at); return at >= c.startMs && at < endMs }).join(' ')
  return text ? [{ track: c.track, startMs: c.startMs, endMs, text }] : []
}
