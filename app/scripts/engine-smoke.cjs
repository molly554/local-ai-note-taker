// Run with Electron, never the packaged app's main entry. No models, microphone or real profile are opened.
// electron scripts/engine-smoke.cjs /path/to/app.asar
const { app, utilityProcess } = require('electron')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const archive = process.argv[2]
if (!archive || !existsSync(archive)) throw new Error('Pass the packaged app.asar path')
const profile = mkdtempSync(join(tmpdir(), 'yogurt-engine-smoke-'))
app.setName('Yogurt Engine Smoke')
app.setPath('userData', profile)

app.whenReady().then(() => {
  const child = utilityProcess.fork(join(resolve(archive), 'out/main/engine.js'), [], { serviceName: 'Yogurt Engine Smoke', stdio: 'pipe' })
  let stderr = '', settled = false
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
  child.stdout.resume()
  const finish = (error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) console.error(`${error}\n${stderr}`)
    else console.log('Packaged notes engine imported its dependencies and answered over IPC')
    child.kill()
    // Windows can still hold the profile's files just after the kill; a leftover temp folder must not keep Electron open
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp folder */ }
    app.exit(error ? 1 : 0)
  }
  const timer = setTimeout(() => finish('Packaged notes engine did not answer within 15 seconds'), 15_000)
  child.on('exit', (code) => finish(`Packaged notes engine exited before answering (code ${code})`))
  child.on('message', (event) => {
    if (event.id !== 1) return
    // The expected error proves the real worker reached its handler without loading a model.
    finish(event.type === 'error' && event.message === 'No model loaded' ? null : `Unexpected packaged engine response: ${JSON.stringify(event)}`)
  })
  child.postMessage({ id: 1, type: 'count', texts: ['packaged startup check'] })
}).catch((error) => { console.error(error); rmSync(profile, { recursive: true, force: true }); app.exit(1) })
