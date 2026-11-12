// Run with Electron: electron scripts/engine-model-smoke.cjs /path/to/app.asar /path/to/model.gguf
// The packaged notes engine does what the app does after a meeting: checks the graphics, loads a real model with the
// app's context sizes, and writes a few words. Each step's time is printed, so a stall shows where it stopped.
// CI only (preview.yml, engine-real.yml): no real profile, microphone or meeting is opened.
const { app, utilityProcess } = require('electron')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const [archive, model] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const gpuOff = process.argv.includes('--gpu-off')
if (!archive || !existsSync(archive)) throw new Error('Pass the packaged app.asar path')
if (!model || !existsSync(model)) throw new Error('Pass a .gguf model path')
// the app's own (shared/engine-protocol.ts)
const CONTEXT = 32_768, MIN_CONTEXT = 8192
const STEP_MS = { probe: 120_000, load: 600_000, chat: 600_000 }

const profile = mkdtempSync(join(tmpdir(), 'yogurt-engine-model-'))
app.setName('Yogurt Engine Model Smoke')
app.setPath('userData', profile)

app.whenReady().then(async () => {
  const child = utilityProcess.fork(join(resolve(archive), 'out/main/engine.js'), [], {
    serviceName: 'Yogurt Engine Model Smoke', stdio: 'pipe', ...(gpuOff ? { env: { ...process.env, YOGURT_ENGINE_GPU: 'off' } } : {}),
  })
  child.stdout.on('data', (c) => process.stdout.write(`[engine] ${c}`))
  child.stderr.on('data', (c) => process.stderr.write(`[engine] ${c}`))
  const pending = new Map()
  let nextId = 1, words = ''
  child.on('message', (e) => {
    if (e.type === 'token') { if (!e.thought) words += e.text; return }
    if (e.type === 'timing') { console.log(`TIMING ${e.text}`); return }
    const p = pending.get(e.id)
    if (!p) return
    pending.delete(e.id)
    if (e.type === 'result') p.resolve(e.data); else p.reject(new Error(e.message))
  })
  child.on('exit', (code) => { for (const p of pending.values()) p.reject(new Error(`engine exited (code ${code})`)); pending.clear() })
  const call = (req, step) => new Promise((res, rej) => {
    const id = nextId++
    const timer = setTimeout(() => rej(new Error(`${step} did not finish within ${STEP_MS[step] / 1000} s`)), STEP_MS[step])
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v) }, reject: (e) => { clearTimeout(timer); rej(e) } })
    child.postMessage({ ...req, id })
  })
  const timed = async (step, req) => {
    const t0 = Date.now()
    console.log(`${step}: start`)
    const r = await call(req, step)
    console.log(`${step}: ${((Date.now() - t0) / 1000).toFixed(1)} s ${JSON.stringify(r).slice(0, 300)}`)
    return r
  }
  let failed = null
  try {
    await timed('probe', { type: 'probe' })
    await timed('load', { type: 'load', modelPath: resolve(model), contextSize: CONTEXT, minContext: MIN_CONTEXT })
    const answer = await timed('chat', { type: 'chat', messages: [{ role: 'user', content: 'Say hello in five words.' }], thoughtBudget: 0, maxTokens: 24 })
    if (!String(answer).trim()) throw new Error('The model wrote nothing')
    console.log(`words: ${JSON.stringify(words)}`)
  } catch (e) { failed = e }
  child.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp folder */ }
  if (failed) console.error(String(failed))
  else console.log('The packaged notes engine loaded a real model and wrote')
  app.exit(failed ? 1 : 0)
}).catch((error) => { console.error(error); app.exit(1) })
