// Smoke test for yogurt-mcp on Windows and Linux: node smoke.mjs path/to/yogurt-mcp(.exe)
// A stand-in Yogurt (server.mjs) listens where the app would (the socket in the profile, or the pipe named in
// mcp.pipe), and the helper has to pass an AI app's MCP messages through both ways, as the Mac helper does.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const relay = resolve(process.argv[2])
const here = dirname(fileURLToPath(import.meta.url))
const win = process.platform === 'win32'
// SMOKE_NO_LAUNCH=1 leaves out the starting of Yogurt (to try this script on the Mac helper, which would open the real Yogurt)
const launches = process.env.SMOKE_NO_LAUNCH !== '1'
const NOT_RUNNING = "Lynote NoteTaker isn't running, and it couldn't be opened. Open Lynote NoteTaker, then try again.\n"
const TOO_LONG = "Lynote NoteTaker's folder path is too long for its connection.\n"

let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(50) }
  return false
}
const profile = () => mkdtempSync(join(tmpdir(), 'ym-'))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function startServer(dir) {
  const p = spawn(process.execPath, [join(here, 'server.mjs'), dir], { stdio: 'inherit' })
  if (!(await until(() => existsSync(join(dir, 'ready'))))) throw new Error('the stand-in server did not start')
  return p
}

/** the helper, started as an AI app starts it */
function run(dir, env = {}) {
  const base = { ...process.env, YOGURT_USER_DATA: dir }
  delete base.YOGURT_MCP_NO_LAUNCH
  const p = spawn(relay, [], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const r = { p, lines: [], raw: '', err: '', code: undefined }
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => { r.raw += d; let i; while ((i = r.raw.indexOf('\n')) >= 0) { r.lines.push(JSON.parse(r.raw.slice(0, i))); r.raw = r.raw.slice(i + 1) } })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (d) => { r.err += d })
  r.exited = new Promise((res) => p.on('exit', (code) => { r.code = code; res(code) }))
  r.send = (msg) => p.stdin.write(JSON.stringify(msg) + '\n')
  return r
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }
const exitsWithin = (r, ms) => Promise.race([r.exited, sleep(ms).then(() => 'still running')])

// 1. messages both ways, in order, split and joined across writes, and a big one
{
  const dir = profile(), server = await startServer(dir)
  const r = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
  r.p.stdin.write(JSON.stringify(init) + '\n' + '{"jsonrpc":"2.0","id":2,')
  await sleep(300)
  r.p.stdin.write('"method":"ping"}\n')
  check(await until(() => r.lines.length === 2), 'initialize and a split ping come back')
  check(r.lines[0]?.id === 1 && r.lines[0]?.result?.serverInfo?.name === 'yogurt' && r.lines[0]?.result?.protocolVersion === '2025-06-18', 'the initialize answer is passed through as is')
  check(JSON.stringify(r.lines[1]) === '{"jsonrpc":"2.0","id":2,"result":{}}', 'the ping answer is passed through as is')
  const text = 'é'.repeat(150_000) + '\u{1F600}'
  r.send({ jsonrpc: '2.0', id: 3, method: 'echo', params: { text } })
  check(await until(() => r.lines.length === 3), 'a 300 KB message goes there and back')
  check(r.lines[2]?.result?.echo === text, 'byte for byte, multi-byte characters included')
  r.p.stdin.end()
  check(await exitsWithin(r, 3000) === 0, 'the AI app closing stdin ends the helper (exit 0)')
  check(await until(() => readFileSync(join(dir, 'server.log'), 'utf8').includes('closed')), 'and Yogurt sees the connection end')
  check(r.err === '', 'nothing on stderr')
  server.kill()
}

// 2. Yogurt quitting ends the session
{
  const dir = profile(), server = await startServer(dir)
  const r = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
  r.send(init)
  await until(() => r.lines.length === 1)
  r.send({ jsonrpc: '2.0', id: 2, method: 'bye' })
  check(await exitsWithin(r, 3000) === 0, 'Yogurt going away ends the helper (exit 0)')
  server.kill()
}

// 3. Yogurt not running, and not to be opened
{
  const dir = profile()
  const r = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
  check(await exitsWithin(r, 3000) === 1, 'no Yogurt: exit 1')
  check(r.err === NOT_RUNNING, 'with the same words as on a Mac')
  if (win) {
    // a pipe name left from an earlier launch, and a file that names some other pipe
    writeFileSync(join(dir, 'mcp.pipe'), '\\\\.\\pipe\\yogurt-mcp-00ff')
    const stale = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
    check(await exitsWithin(stale, 3000) === 1 && stale.err === NOT_RUNNING, 'a pipe name left by a crash: not running')
    writeFileSync(join(dir, 'mcp.pipe'), '\\\\.\\pipe\\something-else')
    const other = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
    check(await exitsWithin(other, 3000) === 1 && other.err === NOT_RUNNING, 'some other pipe in mcp.pipe is not followed')
  }
  if (launches) {
    // what Yogurt recorded is gone (the AppImage was deleted): says so at once, no 30 s wait
    writeFileSync(join(dir, 'mcp-launch'), join(dir, win ? 'gone.exe' : 'gone.AppImage'))
    const gone = run(dir)
    check(await exitsWithin(gone, 3000) === 1 && gone.err === NOT_RUNNING, 'the recorded Yogurt is gone: not running, at once')
  }
}

// 4. Yogurt not running: started from what it recorded, in the background, and left running after
if (launches) {
  const dir = profile()
  const launcher = join(dir, win ? 'Yogurt.cmd' : 'Yogurt.AppImage')
  if (win) writeFileSync(launcher, `@"${process.execPath}" "${join(here, 'server.mjs')}" "${dir}" %*\r\n`)
  else { writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'server.mjs')}" "${dir}" "$@"\n`); chmodSync(launcher, 0o755) }
  writeFileSync(join(dir, 'mcp-launch'), launcher + '\n')
  const r = run(dir)
  r.send(init)
  check(await until(() => r.lines.length === 1, 35_000), 'Yogurt is started, then the first message gets its answer')
  check(existsSync(join(dir, 'server.args')) && readFileSync(join(dir, 'server.args'), 'utf8') === '["--hidden"]', 'started with --hidden')
  r.p.stdin.end()
  check(await exitsWithin(r, 3000) === 0, 'the session ends as usual')
  const pid = Number(readFileSync(join(dir, 'server.pid'), 'utf8'))
  await sleep(500)
  check(alive(pid), 'Yogurt keeps running after the AI app is done')
  if (alive(pid)) process.kill(pid)
}

// 5. Linux: a profile path too long for a Unix socket
if (!win) {
  let dir = profile()
  while (join(dir, 'mcp.sock').length < 120) { dir = join(dir, 'a'.repeat(40)); mkdirSync(dir) }
  const r = run(dir, { YOGURT_MCP_NO_LAUNCH: '1' })
  check(await exitsWithin(r, 3000) === 1 && r.err === TOO_LONG, 'a too long folder path: exit 1, the same words as on a Mac')
}

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
