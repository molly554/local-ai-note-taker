#!/usr/bin/env node
// Checks a built whisper-server the way the app uses it: started by the app's own launcher (src/main/asr/server.ts,
// so the same arguments, random port and health check), then sent short 16 kHz WAV clips with the same form fields
// as asr/transcribe.ts. Prints how long each clip took against its length (the realtime factor, under 1 keeps up).
//
//   node scripts/whisper-smoke.mjs --bin <whisper-server> --model <ggml .bin> [--vad <silero .bin>]
//     --wav a.wav,b.wav [--expect word,word] [--runs 3] [--label name] [--silence] [--unicode-dir] [--threads N]
// --expect: words the first clip must contain. --silence: also send 3 s of silence, which crashed the server with VAD on
// before native/whisper-server.patch. --unicode-dir: first copy the program's folder, the model and the VAD model under a
// folder named like a Windows user called José (and a few more scripts), as an installed copy and its models would be.
// --threads: whisper's threads, by default 4 (what the app passes) but never more than the computer has: with more threads
// than cores whisper slowed down 5 to 200 times (ggml's threads wait by spinning). Writes a row to $GITHUB_STEP_SUMMARY when it is set.
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { registerHooks } from 'node:module'
import { parseArgs } from 'node:util'

// the app's sources import each other without extensions (the bundler finds them); plain Node needs the .ts
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e }
  },
})
const { createWhisperServer } = await import('../src/main/asr/server.ts')

const { values: a } = parseArgs({
  options: {
    bin: { type: 'string' }, model: { type: 'string' }, vad: { type: 'string' }, wav: { type: 'string' },
    expect: { type: 'string' }, runs: { type: 'string', default: '3' }, label: { type: 'string' }, silence: { type: 'boolean' }, 'unicode-dir': { type: 'boolean' }, threads: { type: 'string' },
  },
})
if (!a.bin || !a.model || !a.wav) { console.error('--bin, --model and --wav are needed'); process.exit(2) }
const runs = Number(a.runs)
const label = a.label ?? basename(a.model)
const threads = Number(a.threads ?? Math.min(4, availableParallelism()))
if (a['unicode-dir']) {
  const home = join(mkdtempSync(join(tmpdir(), 'w-')), 'Users', 'Jos\u00e9 \u00d1and\u00fa \u6d4b\u8bd5')
  cpSync(dirname(a.bin), join(home, 'bin'), { recursive: true })
  for (const k of ['model', 'vad']) if (a[k]) { cpSync(a[k], join(home, 'models', basename(a[k]))); a[k] = join(home, 'models', basename(a[k])) }
  a.bin = join(home, 'bin', basename(a.bin))
  console.log(`running from ${a.bin}`)
}

/** milliseconds of 16-bit PCM in a WAV file */
const wavMs = (buf) => {
  let off = 12, rate = 16000, channels = 1, bits = 16
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22) }
    if (id === 'data') return (size / (channels * rate * (bits / 8))) * 1000
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}
const silenceWav = (ms) => {
  const n = Math.round(16 * ms), b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

const srv = createWhisperServer({ binary: a.bin, model: a.model, vadModel: a.vad, threads, startTimeoutMs: 300_000 })
const t0 = performance.now()
let failed = false
try {
  await srv.url()
  const loadMs = performance.now() - t0
  console.log(`${label}: started and loaded in ${(loadMs / 1000).toFixed(1)} s, ${threads} threads on ${cpus().length} x ${cpus()[0]?.model}`)

  // the fields asr/transcribe.ts sends; a partial is read greedily
  const send = async (bytes, partial) => {
    const form = new FormData()
    form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'chunk.wav')
    form.set('response_format', 'verbose_json')
    form.set('language', 'en')
    form.set('temperature', '0.0')
    form.set('no_timestamps', 'false')
    if (partial) { form.set('beam_size', '1'); form.set('best_of', '1') }
    const s = performance.now()
    const res = await fetch(`${await srv.url()}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(600_000) })
    if (!res.ok) throw new Error(`inference answered ${res.status}: ${await res.text()}`)
    const body = await res.json()
    return { ms: performance.now() - s, text: (body.text ?? '').trim() }
  }

  const rows = []
  for (const [i, file] of a.wav.split(',').entries()) {
    const bytes = readFileSync(file)
    const ms = wavMs(bytes)
    const first = await send(bytes, false) // also warms up
    console.log(`${basename(file)} (${(ms / 1000).toFixed(1)} s): ${first.text}`)
    if (i === 0 && a.expect) {
      const missing = a.expect.split(',').filter((w) => !first.text.toLowerCase().includes(w.toLowerCase()))
      if (missing.length) { console.error(`missing words: ${missing.join(', ')}`); failed = true }
    }
    const time = async (partial) => {
      let total = 0
      for (let r = 0; r < runs; r++) total += (await send(bytes, partial)).ms
      return total / runs / ms
    }
    const final = await time(false), partial = await time(true)
    rows.push({ clip: basename(file), seconds: +(ms / 1000).toFixed(1), final: +final.toFixed(3), partial: +partial.toFixed(3) })
  }

  if (a.silence) {
    const r = await send(silenceWav(3000), false)
    if (!(await srv.alive())) { console.error('the server died on silence'); failed = true }
    else console.log(`silence: "${r.text}" (server still up)`)
  }

  for (const r of rows) console.log(`RTF ${label} ${r.clip}: final (beam 5) ${r.final}, partial (greedy) ${r.partial}`)
  console.log(`RESULT ${JSON.stringify({ label, os: process.platform, threads, cpus: cpus().length, cpu: cpus()[0]?.model, loadMs: Math.round(loadMs), rows })}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rows.map((r) =>
      `| ${process.platform} | ${label} | ${r.clip} (${r.seconds} s) | ${r.final} | ${r.partial} | ${(loadMs / 1000).toFixed(1)} s | ${threads} | ${cpus().length} x ${cpus()[0]?.model} |\n`).join(''))
  }
} catch (e) {
  console.error(e)
  failed = true
} finally {
  await srv.stop()
}
process.exit(failed ? 1 : 0)
