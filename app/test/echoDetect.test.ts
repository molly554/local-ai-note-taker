import { describe, expect, it } from 'vitest'
import { EchoDetector } from '../src/main/asr/echoDetect'
import { echoIds } from '../src/main/asr/echo'

const RATE = 16000
/** speech-like bursts: 300 ms on, 200 ms off, with a tone inside, `sec` long */
function bursts(sec: number, amp = 0.3, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE))
  let x = seed
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const on = (t % 0.5) < 0.3 ? 1 : 0.02
    out[i] = amp * on * (Math.sin(i / 7) * 0.6 + (rnd() - 0.5) * 0.8)
  }
  return out
}
const quiet = (sec: number) => new Float32Array(Math.round(sec * RATE))
/** the other side leaking into the mic: quieter, 60 ms late */
function leak(them: Float32Array, gain = 0.3, delayMs = 60): Float32Array {
  const d = Math.round(delayMs * 16), out = new Float32Array(them.length)
  for (let i = d; i < out.length; i++) out[i] = gain * them[i - d]
  return out
}
function feed(det: EchoDetector, me: Float32Array, them: Float32Array) {
  for (let i = 0; i < Math.max(me.length, them.length); i += 1600) {
    if (i < them.length) det.push('them', i / 16, them.subarray(i, i + 1600))
    if (i < me.length) det.push('me', i / 16, me.subarray(i, i + 1600))
  }
}

describe('echo evidence from the audio itself', () => {
  it('headphones: the mic is quiet or has its own voice while they talk, so there is no echo', () => {
    const them = bursts(12)
    const det = new EchoDetector()
    feed(det, quiet(12), them)
    expect(det.present()).toBe(false)
    const det2 = new EchoDetector()
    // the person talks at the same time, in their own rhythm
    feed(det2, bursts(12, 0.3, 7).map((v, i) => ((i / RATE) % 0.7 < 0.35 ? v : 0.01 * v)), them)
    expect(det2.present()).toBe(false)
  })
  it('no headphones: their voice from the speakers lands on the mic, quieter and a little late', () => {
    const them = bursts(24)
    const det = new EchoDetector()
    feed(det, leak(them), them)
    expect(det.present()).toBe(true)
    expect(det.windows).toBeGreaterThanOrEqual(3)
  })
  it.skip('a long line of theirs copied almost word for word on the mic is evidence too (round 2: no longer on its own)', () => {
    const det = new EchoDetector()
    expect(det.present()).toBe(false)
    det.noteVerbatim()
    expect(det.present()).toBe(true)
  })
})

describe("round 2: the reviewer's detector probe", () => {
  /** speech-like bursts with random lengths and pauses, seeded */
  function speech(sec: number, seed: number, amp = 0.2) {
    let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
    const out = new Float32Array(sec * RATE); let i = 0
    while (i < out.length) {
      const on = Math.round((0.08 + rnd() * 0.25) * RATE), off = Math.round((0.03 + rnd() * (rnd() < 0.15 ? 0.6 : 0.12)) * RATE); const a = amp * (0.3 + rnd())
      for (let k = 0; k < on && i < out.length; k++, i++) out[i] = a * Math.sin(Math.PI * k / on) * (rnd() - 0.5) * 2
      for (let k = 0; k < off && i < out.length; k++, i++) out[i] = 0.001 * (rnd() - 0.5)
    }
    return out
  }
  const run = (me: Float32Array, them: Float32Array) => { const d = new EchoDetector(); feed(d, me, them); return d }
  // forty three-minute meetings: a few seconds of work, more when the other test files run beside it
  it('three minutes of two people talking over each other, twenty times, never count as echo; nor a quiet mic', { timeout: 20_000 }, () => {
    for (const meAmp of [0.2, 0.002]) {
      let flagged = 0
      for (let seed = 1; seed <= 20; seed++) { if (run(speech(180, seed * 104729 + 3, meAmp), speech(180, seed * 7919)).present()) flagged++ }
      expect(flagged, `mic amp ${meAmp}`).toBe(0)
    }
  })
  it('a real leak is heard within a minute, at a steady lag', () => {
    const them = speech(60, 7919)
    const d = run(leak(them, 0.3, 60), them)
    expect(d.present()).toBe(true)
    expect(d.correlatedAt(30_000)).toBe(true)
  })
  it('a long verbatim line is no evidence on its own', () => {
    const d = new EchoDetector()
    d.noteVerbatim()
    expect(d.present()).toBe(false)
  })
})

describe('round 2: a room with two paths from the speakers to the mic', () => {
  it('a leak whose lag changes between two values is still echo when most active windows correlate', () => {
    const them = bursts(30)
    const d = new EchoDetector()
    // the leak arrives 60 ms late in the first half and 140 ms late in the second (a different path)
    const a = leak(them.subarray(0, 15 * RATE), 0.3, 60), b = leak(them.subarray(15 * RATE), 0.3, 140)
    const me = new Float32Array(them.length); me.set(a, 0); me.set(b, 15 * RATE)
    feed(d, me, them)
    expect(d.present()).toBe(true)
  })
})

describe('round 3: the detector needs a good stretch of both sides before it can turn on', () => {
  it('nine active windows of leak are not yet evidence; ten are', () => {
    const them = bursts(24)
    const d = new EchoDetector()
    feed(d, leak(them), them)
    expect(d.active).toBeGreaterThanOrEqual(10)
    expect(d.present()).toBe(true)
    const short = new EchoDetector()
    const t2 = bursts(16)
    feed(short, leak(t2), t2)
    expect(short.active).toBeLessThan(10)
    expect(short.present()).toBe(false)
  })
  it('correlatedAt looks only at the window holding the moment', () => {
    const them = bursts(24)
    const d = new EchoDetector()
    feed(d, leak(them), them)
    // correlated windows cover the talk; a moment long after it is not
    expect(d.correlatedAt(5000)).toBe(true)
    expect(d.correlatedAt(60_000)).toBe(false)
  })
})

describe('round 4: a mic line judged by its own audio', () => {
  /** quiet speech of theirs: one short burst of `ms` at `atSec`, otherwise silence, so the 2 s window around it stays below the detector's level gate */
  const faintBurst = (sec: number, atSec: number, ms: number, amp = 0.015) => {
    const out = quiet(sec)
    for (let i = Math.round(atSec * RATE); i < Math.round((atSec + ms / 1000) * RATE); i++) out[i] = amp * (Math.sin(i / 7) * 0.6 + (((i * 7919) % 1000) / 1000 - 0.5) * 0.8)
    return out
  }
  const concat = (...xs: Float32Array[]) => { const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length } return out }
  it('knows nothing before the room has shown its lag', () => {
    const d = new EchoDetector()
    feed(d, quiet(10), bursts(10))
    expect(d.over(2000, 4000)).toBeUndefined()
  })
  it('a leaked line is correlated, no louder than the leak, and pure: nothing on the mic but their voice', () => {
    const them = bursts(24)
    const d = new EchoDetector()
    feed(d, leak(them), them)
    expect(d.present()).toBe(true)
    expect(d.over(10_000, 12_000)).toEqual({ correlated: true, loud: true, pure: true })
  })
  it("the person's own loud line over a faint copy of their voice on the other track (far-end echo) is not loud like the leak", () => {
    const them = bursts(24)
    // 24 s of their speech leaking in, then the person talks alone for 6 s while the other side carries a quiet copy of it
    const own = bursts(6, 0.3, 7)
    const d = new EchoDetector()
    feed(d, concat(leak(them), own), concat(them, own.map((v) => 0.2 * v)))
    const m = d.over(26_000, 29_000)!
    expect(m.loud).toBe(false)
    expect(m.pure).toBe(false)
  })
  it('a short burst of their speech inside a window too quiet for the detector is still judged on its own span', () => {
    const them = concat(bursts(24), faintBurst(6, 2.5, 400))
    const d = new EchoDetector()
    feed(d, leak(them, 0.3, 60), them)
    // the window 26 to 28 s holds only 400 ms of faint speech: the detector never looked at it
    expect(d.correlatedAt(26_700)).toBe(false)
    expect(d.over(26_450, 27_000)).toEqual({ correlated: true, loud: true, pure: true })
  })
  it('a span where they hardly speak is no echo, whatever the windows say', () => {
    const them = bursts(24)
    const d = new EchoDetector()
    feed(d, concat(leak(them), bursts(4, 0.3, 7)), concat(them, quiet(4)))
    expect(d.over(25_000, 27_000)).toEqual({ correlated: false, loud: false, pure: false })
  })
  it('remembers the whole meeting: a line from three minutes back is still judged', () => {
    const them = bursts(200)
    const d = new EchoDetector()
    feed(d, leak(them), them)
    expect(d.over(10_000, 12_000)).toEqual({ correlated: true, loud: true, pure: true })
  })
  it('round 5: keeps two hours of audio and every verdict it gave; a line older than that, never asked about, is unknown', () => {
    const them = bursts(24), mic = leak(them)
    const d = new EchoDetector()
    feed(d, mic, them)
    expect(d.over(10_000, 12_000)).toEqual({ correlated: true, loud: true, pure: true })
    // the meeting runs on past two hours (a jump, as after a long pause)
    const late = 2 * 3600_000 + 30_000
    d.push('them', late, quiet(1)); d.push('me', late, quiet(1))
    expect(d.over(10_000, 12_000)).toEqual({ correlated: true, loud: true, pure: true })
    expect(d.over(12_000, 14_000)).toBeUndefined()
  })
  it("round 5: the mic's level is taken over the whole line: the person's own words in their pauses make it loud", () => {
    const them = bursts(24)
    // their voice leaks in; the person speaks only in the middle of their pauses, a few times louder than the leak
    const own = Float32Array.from({ length: them.length }, (_, i) => { const t = (i / RATE) % 0.5; return t >= 0.36 && t < 0.48 ? 0.4 * (Math.sin(i / 11) * 0.6 + (((i * 7919) % 1000) / 1000 - 0.5) * 0.8) : 0 })
    const d = new EchoDetector()
    feed(d, leak(them).map((v, i) => v + own[i]), them)
    expect(d.present()).toBe(true)
    expect(d.over(10_000, 12_000)!.loud).toBe(false)
  })
})

describe("round 5: the reviewer's probes: a real line of the person's is never hidden on audio", () => {
  const R = RATE
  function speech(sec: number, seed: number, amp = 0.2) {
    let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
    const out = new Float32Array(Math.round(sec * R)); let i = 0
    while (i < out.length) {
      const on = Math.round((0.08 + rnd() * 0.25) * R), off = Math.round((0.03 + rnd() * (rnd() < 0.15 ? 0.6 : 0.12)) * R); const a = amp * (0.3 + rnd())
      for (let k = 0; k < on && i < out.length; k++, i++) out[i] = a * Math.sin(Math.PI * k / on) * (rnd() - 0.5) * 2
      for (let k = 0; k < off && i < out.length; k++, i++) out[i] = 0.001 * (rnd() - 0.5)
    }
    return out
  }
  function music(sec: number, seed: number, amp = 0.15) {
    let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
    return Float32Array.from({ length: Math.round(sec * R) }, (_, i) => { const t = i / R; return amp * (0.6 + 0.4 * Math.abs(Math.sin(Math.PI * 2 * t))) * (Math.sin(2 * Math.PI * 220 * t) * 0.5 + (rnd() - 0.5)) })
  }
  const silence = (sec: number) => Float32Array.from({ length: Math.round(sec * R) }, (_, i) => 0.0005 * (((i * 7919) % 1000) / 1000 - 0.5))
  const cat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length } return o }
  const delay = (x: Float32Array, g: number, lagMs: number) => { const l = Math.round(lagMs * 16), o = new Float32Array(x.length); for (let i = l; i < x.length; i++) o[i] = g * x[i - l]; return o }
  const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0))
  const at = (x: Float32Array, startSec: number, total: number) => { const o = new Float32Array(Math.round(total * R)); o.set(x.subarray(0, Math.min(x.length, o.length - Math.round(startSec * R))), Math.round(startSec * R)); return o }
  const WARM = 30, LEAK = 0.3, LAG = 60, SEEDS = 5
  /** is the person's line (id 1) hidden by the rules, given their lines? */
  function hidden(them: Float32Array, me: Float32Array, a: number, b: number, own: string, theirs: Array<{ text: string; startMs: number; endMs: number }>) {
    const d = new EchoDetector()
    for (let i = 0; i < them.length; i += 1600) { d.push('them', i / 16, them.subarray(i, i + 1600)); d.push('me', i / 16, me.subarray(i, i + 1600)) }
    const segs = [{ id: 1, meetingId: 'm', track: 'me' as const, text: own, startMs: a, endMs: b }, ...theirs.map((t, i) => ({ id: 10 + i, meetingId: 'm', track: 'them' as const, ...t }))]
    return echoIds(segs, { echo: d.present(), correlatedAt: (ms) => d.correlatedAt(ms), over: (x, y) => d.over(x, y) }).includes(1)
  }
  const OWN = 'Let me check the budget numbers first'
  const THEIRS = 'we should look at the marketing plan before we decide'
  it('A: the person talks over them, quietly (a quarter, a half, the same as the leak), unrelated words: kept', () => {
    for (const q of [0.25, 0.5, 1]) for (let s = 1; s <= SEEDS; s++) {
      const T = WARM + 6, them = cat(speech(WARM, s * 7919), speech(6, s * 13 + 1)), own = at(speech(3, s * 31 + 5, 0.2 * LEAK * q), WARM + 1.5, T)
      expect(hidden(them, add(delay(them, LEAK, LAG), own), (WARM + 1.5) * 1000, (WARM + 4.5) * 1000, OWN, [{ text: THEIRS, startMs: WARM * 1000, endMs: (WARM + 6) * 1000 }]), `own/leak ${q} seed ${s}`).toBe(false)
    }
  })
  it('C2: music with a lyrics line through the speakers, the person talks over it quietly: kept', () => {
    for (const q of [0.25, 0.5, 1]) for (let s = 1; s <= SEEDS; s++) {
      const T = WARM + 10, them = cat(speech(WARM, s * 7919), music(10, s)), own = at(speech(4, s * 31 + 5, 0.2 * LEAK * q), WARM + 3, T)
      expect(hidden(them, add(delay(them, LEAK, LAG), own), (WARM + 3) * 1000, (WARM + 7) * 1000, OWN, [{ text: 'la la la the night is young', startMs: WARM * 1000, endMs: (WARM + 10) * 1000 }]), `own/leak ${q} seed ${s}`).toBe(false)
    }
  })
  it("F: a loud read-back right after their line, whisper's span starting half a second to two seconds early: kept", () => {
    for (const early of [0.5, 1, 2]) for (let s = 1; s <= SEEDS; s++) {
      const T = WARM + 7, them = cat(speech(WARM, s * 7919), speech(3, s * 13 + 1), silence(4)), own = at(speech(3, s * 31 + 5, 0.2 * LEAK * 4), WARM + 3.2, T)
      expect(hidden(them, add(delay(them, LEAK, LAG), own), (WARM + 3.2 - early) * 1000, (WARM + 6.2) * 1000, 'Send you the report by Friday? Sure.', [{ text: 'can you send me the report by Friday', startMs: WARM * 1000, endMs: (WARM + 3) * 1000 }]), `${early} s early seed ${s}`).toBe(false)
    }
  })
})

describe("round 3: the reviewer's turn-taking probe (shortened)", () => {
  const SEC = 120
  function speech(sec: number, seed: number, amp = 0.2) {
    let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
    const out = new Float32Array(sec * RATE); let i = 0
    while (i < out.length) {
      const on = Math.round((0.08 + rnd() * 0.25) * RATE), off = Math.round((0.03 + rnd() * (rnd() < 0.15 ? 0.6 : 0.12)) * RATE); const a = amp * (0.3 + rnd())
      for (let k = 0; k < on && i < out.length; k++, i++) out[i] = a * Math.sin(Math.PI * k / on) * (rnd() - 0.5) * 2
      for (let k = 0; k < off && i < out.length; k++, i++) out[i] = 0.002 * (rnd() - 0.5)
    }
    return out
  }
  /** who talks when: turns of 3 to 12 s, plus random stretches where both talk */
  function turns(seed: number, overlap: number) {
    let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff }
    const th = new Float32Array(SEC * RATE), me = new Float32Array(SEC * RATE); let i = 0, who = 0
    while (i < SEC * RATE) { const len = Math.round((3 + rnd() * 9) * RATE); for (let k = 0; k < len && i < SEC * RATE; k++, i++) { if (who === 0) th[i] = 1; else me[i] = 1 } who = 1 - who }
    for (let n = 0; n < overlap * 14; n++) { const at = Math.floor(rnd() * (SEC - 3) * RATE), len = Math.round((0.5 + rnd() * 2) * RATE); for (let k = 0; k < len; k++) { th[at + k] = 1; me[at + k] = 1 } }
    return [th, me]
  }
  const apply = (s: Float32Array, m: Float32Array) => s.map((v, i) => v * m[i] + 0.002 * (Math.random() - 0.5))
  const delayed = (s: Float32Array, g: number, sec: number) => { const o = new Float32Array(s.length); const d = Math.round(sec * RATE); for (let i = d; i < s.length; i++) o[i] = g * s[i - d]; return o }
  const add = (...xs: Float32Array[]) => xs[0].map((_, i) => xs.reduce((a, x) => a + x[i], 0))
  const run = (them: Float32Array, me: Float32Array) => { const d = new EchoDetector(); let ever = false; for (let i = 0; i < them.length; i += 1600) { d.push('them', i / 16, them.subarray(i, i + 1600)); d.push('me', i / 16, me.subarray(i, i + 1600)); if (i % 32000 === 0 && d.present()) ever = true } return { end: d.present(), ever } }
  const scene = (seed: number, gain: number, paths: number[], overlap: number) => {
    const [tm, mm] = turns(seed * 13 + 1, overlap)
    const tv = apply(speech(SEC, seed * 7919), tm), mv = apply(speech(SEC, seed * 104729 + 3), mm)
    return run(tv, add(mv, ...paths.map((l) => delayed(tv, gain, l))))
  }
  it('people taking turns with headphones, even talking over each other a lot, never count as echo', () => {
    for (const overlap of [1, 4]) for (let seed = 1; seed <= 6; seed++) { const r = scene(seed, 0, [], overlap); expect(r.ever, `overlap ${overlap} seed ${seed}`).toBe(false) }
  })
  it('a leak at -16 dB with turns is heard, also over two paths', () => {
    let heard = 0
    for (let seed = 1; seed <= 6; seed++) { if (scene(seed, 0.15, [0.04], 1).end) heard++; if (scene(seed, 0.1, [0.02, 0.15], 1).end) heard++ }
    expect(heard).toBeGreaterThanOrEqual(9)
  })
})
