import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SpeedDeps, SpeedResult } from '../setup'
import { createWhisperServer, type WhisperServer } from './server'
import { createTranscriber } from './transcribe'

/**
 * Windows and Linux: how fast whisper reads speech on this computer, timed once at setup on a bundled clip with the app's
 * own launcher and request (same threads, VAD, beam 5, graphics with the fall back to the processor). Plain Node only
 * (scripts/speed-check-smoke.mjs runs it on CI).
 */

const CLIP = 'clip.wav'
/** the bundled clip (resources/speed, Windows and Linux builds only): John F. Kennedy, 15.4 s, 16 kHz mono */
export function speedClipPath(): string | undefined {
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'speed', CLIP),
    join(__dirname, '../../resources/speed', CLIP),
    join(__dirname, '../../../resources/speed', CLIP),
    join(__dirname, '../../../../resources/speed', CLIP),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c))
}

/** 16-bit PCM samples of a WAV file as floats */
export function readWav(buf: Buffer): Float32Array {
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2), out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

type MeasureOpts = {
  binary: string; vadModel?: string; clip: string
  /** for tests and the CI smoke: another launcher */
  server?: (model: string) => WhisperServer
}

/**
 * The realtime factor of one careful (beam 5) reading of the clip: time taken over its length. The first 3 s are read
 * once beforehand, so loading and the graphics' first-run work are not counted. A reading that takes longer than the
 * clip itself is stopped: null, too slow by far.
 */
export async function measureSpeed(model: string, o: MeasureOpts): Promise<{ rtf: number | null; gpuOff: boolean }> {
  const srv = o.server?.(model) ?? createWhisperServer({ binary: o.binary, model, vadModel: o.vadModel, gpuFallback: true, startTimeoutMs: 180_000, backoffMs: [0] })
  const samples = readWav(readFileSync(o.clip))
  const clipMs = samples.length / 16
  try {
    // a server that dies loading on the graphics card is started once more on the processor (gpuFallback)
    await srv.url().catch(() => srv.url())
    const language = () => 'en'
    await createTranscriber({ url: () => srv.url(), language, timeoutMs: 120_000 })({ track: 'them', startMs: 0, samples: samples.subarray(0, 3 * 16000) })
    const read = createTranscriber({ url: () => srv.url(), language, timeoutMs: Math.round(clipMs) })
    const t0 = performance.now()
    try { await read({ track: 'them', startMs: 0, samples }) } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') return { rtf: null, gpuOff: srv.cpuOnly }
      throw e
    }
    return { rtf: Math.round(((performance.now() - t0) / clipMs) * 1000) / 1000, gpuOff: srv.cpuOnly }
  } finally {
    await srv.stop()
  }
}

/** The speed check's result, kept in one small file in the profile */
export function speedStore(file: string): Pick<SpeedDeps, 'load' | 'save'> & { forget(): void } {
  return {
    load() { try { return JSON.parse(readFileSync(file, 'utf8')) as SpeedResult } catch { return undefined } },
    save(r) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(r, null, 2)); renameSync(file + '.tmp', file) },
    /** the graphics stopped working for whisper after a check timed with them: time again on the next start */
    forget() {
      try { const r = JSON.parse(readFileSync(file, 'utf8')) as SpeedResult; if (!r.gpuOff) writeFileSync(file, JSON.stringify({ ...r, key: '' }, null, 2)) } catch { /* nothing stored */ }
    },
  }
}

/**
 * Fake mode: YOGURT_FAKE_RTF gives every model that time ("2"), or some of them ("whisper-small-q5_1=0.9,whisper-tiny-q5_1=0.2",
 * the rest 0.1); "slow" never finishes in time.
 */
export function fakeMeasure(env = process.env.YOGURT_FAKE_RTF ?? ''): SpeedDeps['measure'] {
  return async (path) => {
    const parse = (v: string) => (v === 'slow' ? null : Number(v))
    if (env && !env.includes('=')) return { rtf: parse(env) }
    for (const part of env.split(',')) {
      const [id, v] = part.split('=')
      if (id && v && path.includes(id.replace(/^whisper-/, 'ggml-'))) return { rtf: parse(v) }
    }
    return { rtf: 0.1 }
  }
}
