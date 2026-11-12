import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeMeasure, measureSpeed, readWav, speedClipPath, speedStore } from '../src/main/asr/speedCheck'
import { wavBytes } from '../src/main/asr/transcribe'
import type { WhisperServer } from '../src/main/asr/server'

const dir = () => mkdtempSync(join(tmpdir(), 'yogurt-speed-'))

describe('the speed check (Windows and Linux)', () => {
  it('ships a 15 s clip of speech, 16 kHz mono', () => {
    const clip = speedClipPath()
    expect(clip).toBeTruthy()
    const n = readWav(readFileSync(clip!)).length
    expect(n / 16000).toBeCloseTo(15.4, 1)
  })

  it('keeps what it found in a file; forgetting a check timed with the graphics makes the next start time again', () => {
    const file = join(dir(), 'speech-speed.json')
    const s = speedStore(file)
    expect(s.load()).toBeUndefined()
    s.save({ key: 'k', model: 'whisper-small-q5_1', rtf: { 'whisper-small-q5_1': 0.3 }, at: 1 })
    expect(speedStore(file).load()).toMatchObject({ key: 'k', model: 'whisper-small-q5_1' })
    s.forget()
    expect(s.load()?.key).toBe('')
    // timed on the processor already (the graphics failed while it was timed): nothing to forget
    s.save({ key: 'k', model: 'whisper-tiny-q5_1', rtf: {}, at: 1, gpuOff: true })
    s.forget()
    expect(s.load()?.key).toBe('k')
  })

  it('fake mode: one time for every model, some models, or too slow', async () => {
    expect(await fakeMeasure('')('/m/ggml-small-q5_1.bin')).toEqual({ rtf: 0.1 })
    expect(await fakeMeasure('2')('/m/ggml-small-q5_1.bin')).toEqual({ rtf: 2 })
    expect(await fakeMeasure('slow')('/m/ggml-small-q5_1.bin')).toEqual({ rtf: null })
    const some = fakeMeasure('whisper-small-q5_1=0.9,whisper-tiny-q5_1=0.2')
    expect(await some('/m/ggml-small-q5_1.bin')).toEqual({ rtf: 0.9 })
    expect(await some('/m/ggml-base-q5_1.bin')).toEqual({ rtf: 0.1 })
  })

  describe('timing a stand-in whisper-server', () => {
    let close: (() => void) | undefined
    afterEach(() => close?.())
    /** answers each careful reading after delayMs; quick readings at once */
    async function standIn(delayMs: number) {
      const asked: string[] = []
      const http = createServer((req, res) => {
        let body = ''
        req.on('data', (d) => { body += d.toString('latin1') })
        req.on('end', () => {
          asked.push(body.includes('name="language"\r\n\r\nen') ? 'en' : 'other')
          setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'hi', segments: [] })) }, asked.length === 1 ? 0 : delayMs)
        })
      })
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
      close = () => http.close()
      const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
      let stopped = false
      const srv = { url: async () => url, stop: async () => { stopped = true }, cpuOnly: false } as unknown as WhisperServer
      return { asked, srv, stopped: () => stopped }
    }
    const clip = (seconds: number) => { const f = join(dir(), 'clip.wav'); writeFileSync(f, wavBytes(new Float32Array(seconds * 16000))); return f }

    it('the time of one careful reading over the clip length, after a warm-up that is not counted; the server is stopped after', async () => {
      const s = await standIn(200)
      const r = await measureSpeed('/m/ggml-tiny-q5_1.bin', { binary: 'x', clip: clip(1), server: () => s.srv })
      expect(r.rtf).toBeGreaterThan(0.15)
      expect(r.rtf).toBeLessThan(0.5)
      expect(r.gpuOff).toBe(false)
      expect(s.asked).toEqual(['en', 'en'])
      expect(s.stopped()).toBe(true)
    })

    it('a reading that takes longer than the clip is stopped: too slow by far', async () => {
      const s = await standIn(1500)
      const r = await measureSpeed('/m/ggml-small-q5_1.bin', { binary: 'x', clip: clip(1), server: () => s.srv })
      expect(r.rtf).toBeNull()
      expect(s.stopped()).toBe(true)
    })
  })
})
