import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWhisperServer, killStale, recoverer } from '../src/main/asr/server'
import { createTranscriber } from '../src/main/asr/transcribe'

/**
 * a stand-in for the whisper-server program: answers GET / on --host/--port once it has "loaded".
 * modes: what each launch does with a request to /inference (the last one repeats): ok, crash (exits), wedge (never answers).
 */
function fakeBinary(loadMs = 0, modes: string[] = ['ok']) {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-ws-'))
  const js = join(dir, 'ws.js')
  writeFileSync(join(dir, 'modes'), modes.join('\n'))
  writeFileSync(js, `
    const fs = require('fs'), dir = ${JSON.stringify(dir)}
    fs.appendFileSync(dir + '/launches', String(process.pid) + '\\n')
    fs.writeFileSync(dir + '/args', JSON.stringify(process.argv.slice(2)))
    const n = fs.readFileSync(dir + '/launches', 'utf8').trim().split('\\n').length
    const ms = fs.readFileSync(dir + '/modes', 'utf8').split('\\n'), mode = ms[Math.min(n, ms.length) - 1]
    const a = process.argv, port = Number(a[a.indexOf('--port') + 1]), host = a[a.indexOf('--host') + 1]
    if (mode === 'die-loading') process.exit(1)
    setTimeout(() => require('http').createServer((q, r) => {
      if (q.method !== 'POST') return r.end('ok')
      q.resume()
      if (mode === 'crash') process.exit(1)
      if (mode === 'wedge') return
      q.on('end', () => r.end(JSON.stringify({ detected_language: 'english', detected_language_probability: 0.99, segments: [{ start: 0, end: 1, text: ' Fine words here today' }] })))
    }).listen(port, host), ${loadMs})
  `)
  const bin = join(dir, 'whisper-server')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}
const launchPids = (bin: string): number[] => { try { return readFileSync(join(bin, '../launches'), 'utf8').trim().split('\n').map(Number) } catch { return [] } }
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const open: Array<{ stop(): Promise<void> }> = []
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.stop())) })
const make = (bin: string, extra: Partial<Parameters<typeof createWhisperServer>[0]> = {}) => {
  const s = createWhisperServer({ binary: bin, model: '/m.bin', backoffMs: [0, 0, 0], ...extra })
  open.push(s)
  return s
}
const alive = async (url: string) => { try { return (await fetch(url + '/')).ok } catch { return false } }

// the stand-in servers are shell scripts, which Windows can't start
describe.skipIf(process.platform === 'win32')('whisper server', () => {
  it('starts on first use on 127.0.0.1 and answers; asking again reuses it', async () => {
    const s = make(fakeBinary(100))
    expect(s.running).toBe(false)
    const [a, b] = await Promise.all([s.url(), s.url()])
    expect(a).toBe(b)
    expect(a).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await alive(a)).toBe(true)
    expect(await s.url()).toBe(a)
  })

  it('turns on VAD with the bundled model when there is one, so whisper only reads the stretches with speech', async () => {
    const bin = fakeBinary()
    const args = () => JSON.parse(readFileSync(join(bin, '../args'), 'utf8')) as string[]
    const s = make(bin, { vadModel: '/vad.bin' })
    await s.url()
    expect(args()).toEqual(expect.arrayContaining(['--vad', '-vm', '/vad.bin']))
    await s.stop()
    const t = make(bin)
    await t.url()
    expect(args()).not.toContain('--vad')
  })

  it('brings up a new one when the old one was killed', async () => {
    const s = make(fakeBinary())
    const a = await s.url()
    s.kill()
    await new Promise((r) => setTimeout(r, 200))
    expect(await alive(a)).toBe(false)
    const b = await s.url()
    expect(await alive(b)).toBe(true)
  })

  it('stop ends the process', async () => {
    const s = make(fakeBinary())
    const a = await s.url()
    await s.stop()
    expect(s.running).toBe(false)
    expect(await alive(a)).toBe(false)
  })

  it('fails with a clear error when the program is missing', async () => {
    await expect(make('/nonexistent/whisper-server').url()).rejects.toThrow(/whisper-server/)
  })

  it('fails when the program exits before it answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yogurt-ws-'))
    const bin = join(dir, 'whisper-server')
    writeFileSync(bin, '#!/bin/sh\nexit 3\n'); chmodSync(bin, 0o755)
    await expect(make(bin).url()).rejects.toThrow(/exited/)
  })

  it('off a Mac, a server that crashes while loading (a graphics driver) starts again without the graphics card, and stays so', async () => {
    const bin = fakeBinary(0, ['die-loading', 'ok'])
    const args = () => JSON.parse(readFileSync(join(bin, '../args'), 'utf8')) as string[]
    const s = make(bin, { gpuFallback: true })
    await expect(s.url()).rejects.toThrow(/exited/)
    expect(args()).not.toContain('-ng')
    await s.url()
    expect(args()).toContain('-ng')
    s.kill()
    await new Promise((r) => setTimeout(r, 200))
    await s.url()
    expect(args()).toContain('-ng')
  })

  it('a Mac never turns the graphics off, and one that crashes after loading keeps them', async () => {
    const mac = fakeBinary(0, ['die-loading', 'ok'])
    const s = make(mac)
    await expect(s.url()).rejects.toThrow(/exited/)
    await s.url()
    expect(JSON.parse(readFileSync(join(mac, '../args'), 'utf8'))).not.toContain('-ng')
    const bin = fakeBinary()
    const t = make(bin, { gpuFallback: true })
    await t.url()
    t.kill()
    await new Promise((r) => setTimeout(r, 200))
    await t.url()
    expect(JSON.parse(readFileSync(join(bin, '../args'), 'utf8'))).not.toContain('-ng')
  })

  it('never asks for more threads than the computer has', async () => {
    const bin = fakeBinary()
    await make(bin).url()
    const a = JSON.parse(readFileSync(join(bin, '../args'), 'utf8')) as string[]
    expect(Number(a[a.indexOf('-t') + 1])).toBe(Math.min(4, availableParallelism()))
  })

  it('gives up when it never answers in time', async () => {
    await expect(make(fakeBinary(5000), { startTimeoutMs: 400 }).url()).rejects.toThrow(/did not start/)
  })
})

const chunk = { track: 'me' as const, startMs: 0, samples: new Float32Array(16000) }

describe.skipIf(process.platform === 'win32')('restart budget', () => {
  it('a server that dies on every request is relaunched up to 3 times in a meeting, then requests stop going to it', async () => {
    const bin = fakeBinary(0, ['crash'])
    const srv = make(bin)
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv) })
    // more tries than relaunches: a crash that races the alive check only delays one
    for (let i = 0; i < 8; i++) await expect(tr(chunk)).rejects.toThrow()
    expect(srv.launches).toBe(4)
    expect(launchPids(bin)).toHaveLength(4)
  })

  it('waits longer before each relaunch', async () => {
    const waits: number[] = []
    const srv = make(fakeBinary(0, ['crash']), { backoffMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms) } })
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv) })
    for (let i = 0; i < 8; i++) await expect(tr(chunk)).rejects.toThrow()
    expect(waits).toEqual([10, 20, 30])
  })

  it('after 10 minutes without trouble, the relaunches are there again', async () => {
    let t = 0
    const srv = make(fakeBinary(0, ['crash']), { now: () => t })
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv) })
    for (let i = 0; i < 8; i++) await expect(tr(chunk)).rejects.toThrow()
    expect(srv.launches).toBe(4)
    t = 10 * 60_000 + 1
    // relaunched again
    await expect(tr(chunk)).rejects.toThrow()
    expect(srv.launches).toBeGreaterThan(4)
  })

  it('a server that dies once is relaunched and the same chunk goes through', async () => {
    const srv = make(fakeBinary(0, ['crash', 'ok']))
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv) })
    expect((await tr(chunk)).map((l) => l.text)).toEqual(['Fine words here today'])
    expect(srv.launches).toBe(2)
  })

  it('a server that is running but never answers is killed and relaunched once', async () => {
    const bin = fakeBinary(0, ['wedge', 'ok'])
    const srv = make(bin)
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv), timeoutMs: 400 })
    expect((await tr(chunk)).map((l) => l.text)).toEqual(['Fine words here today'])
    expect(srv.launches).toBe(2)
    const [first] = launchPids(bin)
    await new Promise((r) => setTimeout(r, 200))
    expect(isAlive(first)).toBe(false)
  })

  it('a server that keeps wedging is relaunched 3 times, then left alone', async () => {
    const srv = make(fakeBinary(0, ['wedge']))
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv), timeoutMs: 300 })
    for (let i = 0; i < 5; i++) await expect(tr(chunk)).rejects.toThrow()
    expect(srv.launches).toBe(4)
  })

  it('a new meeting gets a new budget', async () => {
    const srv = make(fakeBinary(0, ['crash', 'crash', 'crash', 'crash', 'crash', 'ok']))
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv) })
    for (let i = 0; i < 8; i++) await tr(chunk).catch(() => [])
    expect(srv.launches).toBe(4)
    srv.resetBudget()
    // it starts again; a crash that races the check may cost one try, the next one gets through
    let got: Awaited<ReturnType<typeof tr>> = []
    for (let i = 0; i < 3 && !got.length; i++) got = await tr(chunk).catch(() => [])
    expect(got.length).toBe(1)
    expect(srv.launches).toBeGreaterThan(4)
  })
})

describe.skipIf(process.platform === 'win32')('two tracks failing at once', () => {
  it('both requests wedge, their timeouts land at different times: one kill, one relaunch, both go on in the new child', async () => {
    const bin = fakeBinary(600, ['wedge', 'ok'])
    const srv = make(bin)
    const tr = createTranscriber({ url: () => srv.url(), recover: recoverer(srv), timeoutMs: 700 })
    await srv.url()
    // me times out first and relaunches (a 600 ms load); them times out while that child is still loading
    const me = tr({ ...chunk, track: 'me' })
    await new Promise((r) => setTimeout(r, 300))
    const them = tr({ ...chunk, track: 'them' })
    const [a, b] = await Promise.all([me, them])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(srv.launches).toBe(2)
    expect(launchPids(bin)).toHaveLength(2)
  })

  it('a request that failed on an old child does not kill the relaunch that is already up', async () => {
    const bin = fakeBinary(0, ['wedge', 'ok'])
    const srv = make(bin)
    const old = await srv.url()
    const recover = recoverer(srv)
    await recover('timeout', old)          // track A: kills and relaunches
    const fresh = await srv.url()
    expect(fresh).not.toBe(old)
    await recover('timeout', old)          // track B, late, still holding the old address
    expect(await srv.url()).toBe(fresh)
    expect(srv.launches).toBe(2)
    expect(await srv.alive()).toBe(true)
  })
})

describe('pid file', () => {
  const rig = (names: Record<number, string | null>) => {
    const killed: number[] = []
    return { killed, deps: { name: (pid: number) => names[pid] ?? null, kill: (pid: number) => { killed.push(pid) } } }
  }
  const pidFile = () => join(mkdtempSync(join(tmpdir(), 'yogurt-pid-')), 'whisper-server.pid')

  it('kills a left-over whisper-server and removes the file', () => {
    const f = pidFile(); writeFileSync(f, '4242')
    const r = rig({ 4242: '/Applications/Yogurt.app/Contents/Resources/bin/whisper-server' })
    killStale(f, r.deps)
    expect(r.killed).toEqual([4242])
    expect(existsSync(f)).toBe(false)
  })

  it('on Windows the program is whisper-server.exe (tasklist gives the name alone)', () => {
    const f = pidFile(); writeFileSync(f, '4242')
    const r = rig({ 4242: 'whisper-server.exe' })
    killStale(f, r.deps)
    expect(r.killed).toEqual([4242])
  })

  it('leaves alone a pid that now belongs to another program, or to nothing', () => {
    const f = pidFile(); writeFileSync(f, '4242')
    const other = rig({ 4242: '/usr/bin/Safari' })
    killStale(f, other.deps)
    expect(other.killed).toEqual([])
    expect(existsSync(f)).toBe(false)
    writeFileSync(f, '77')
    const gone = rig({})
    killStale(f, gone.deps)
    expect(gone.killed).toEqual([])
  })

  it('ignores a missing or garbled file', () => {
    const r = rig({ 1: 'whisper-server' })
    killStale(join(tmpdir(), 'no-such-pid-file'), r.deps)
    const f = pidFile(); writeFileSync(f, 'not a number')
    killStale(f, r.deps)
    expect(r.killed).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('the server writes its pid on launch, clears an old one first, and removes the file on a clean stop', async () => {
    const f = pidFile(); writeFileSync(f, '999999')
    const r = rig({ 999999: 'whisper-server' })
    const srv = make(fakeBinary(), { pidFile: f, lookup: r.deps })
    await srv.url()
    expect(r.killed).toEqual([999999])
    expect(Number(readFileSync(f, 'utf8'))).toBeGreaterThan(0)
    await srv.stop()
    expect(existsSync(f)).toBe(false)
  })
})
