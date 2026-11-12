#!/usr/bin/env node
// The setup speed check for real (Windows and Linux CI): the app's own code (src/main/asr/speedCheck.ts and the picker)
// times a built whisper-server on the bundled clip with the given models, best first, stores the result the way setup
// does, reads it back and checks a time was stored for the first model. Prints the result; a row goes to $GITHUB_STEP_SUMMARY.
//
//   node scripts/speed-check-smoke.mjs --bin <whisper-server> --vad <silero .bin> --model a.bin[,b.bin] [--store file.json]
import { appendFileSync, mkdtempSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { registerHooks } from 'node:module'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

// the app's sources import each other without extensions (the bundler finds them); plain Node needs the .ts
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e }
  },
})
const { measureSpeed, speedStore } = await import('../src/main/asr/speedCheck.ts')
const { pickBySpeed, KEEPS_UP_RTF } = await import('../../packages/picker/src/asr.ts')

const { values: a } = parseArgs({ options: { bin: { type: 'string' }, vad: { type: 'string' }, model: { type: 'string' }, store: { type: 'string' } } })
if (!a.bin || !a.model) { console.error('--bin and --model are needed'); process.exit(2) }
// the clip the app ships (speedClipPath finds it there; plain Node has no __dirname for the app's sources)
const clip = fileURLToPath(new URL('../resources/speed/clip.wav', import.meta.url))
const file = a.store ?? join(mkdtempSync(join(tmpdir(), 'speed-')), 'speech-speed.json')
const models = a.model.split(',').map((path) => ({ id: basename(path), path }))
const key = `${process.platform}|${process.arch}|${cpus()[0]?.model}|${availableParallelism()}|ci`

let gpuOff = false
const r = await pickBySpeed(models, async (m) => {
  const t = await measureSpeed(m.path, { binary: a.bin, vadModel: a.vad, clip })
  if (t.gpuOff) gpuOff = true
  console.log(`${m.id}: ${t.rtf === null ? 'ran out of time' : `${t.rtf} x the clip's length`}${t.gpuOff ? ' (left the graphics card)' : ''}`)
  return t.rtf
})
const store = speedStore(file)
store.save({ key, model: r.model?.id ?? null, rtf: r.rtf, at: Date.now(), ...(gpuOff ? { gpuOff } : {}) })
const back = speedStore(file).load()
console.log(`RESULT ${JSON.stringify(back)}`)
const first = models[0].id
const ok = back?.key === key && first in (back?.rtf ?? {}) && (back.model === null || back.model === first || back.rtf[first] === null || back.rtf[first] > KEEPS_UP_RTF)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nSpeed check (${process.platform}, ${availableParallelism()} x ${cpus()[0]?.model}): kept ${back?.model ?? 'nothing'}; ${Object.entries(back?.rtf ?? {}).map(([k, v]) => `${k} ${v ?? 'too slow'}`).join(', ')}\n`)
}
if (!ok) { console.error('the speed check did not store a result'); process.exit(1) }
