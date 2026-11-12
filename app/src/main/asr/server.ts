import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { helperFile } from '../../shared/platform'

/**
 * whisper-server (whisper.cpp, built by scripts/native.sh) on 127.0.0.1 with a random port.
 * It starts the first time something asks for its address; asr/index.ts stops it a while after the last meeting, and on quit.
 */
export function whisperServerPath(): string {
  const file = helperFile('whisper', process.platform)
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', file),
    join(__dirname, '../../resources/bin', file),
    join(__dirname, '../../../resources/bin', file),
    join(__dirname, '../../../../resources/bin', file),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

const VAD_MODEL = 'ggml-silero-v6.2.0.bin'
/**
 * Silero VAD (scripts/native.sh fetches it, pinned with a sha256): whisper-server reads only the stretches with speech,
 * so a click or a notification on a quiet track is never made into words. Undefined when it is not there (a dev build
 * before native.sh ran): whisper reads everything, as before.
 */
export function vadModelPath(): string | undefined {
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'vad', VAD_MODEL),
    join(__dirname, '../../resources/vad', VAD_MODEL),
    join(__dirname, '../../../resources/vad', VAD_MODEL),
    join(__dirname, '../../../../resources/vad', VAD_MODEL),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c))
}
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})

/** Windows has no ps: tasklist prints "whisper-server.exe","4242",... for a pid that exists, and an INFO line otherwise */
const windowsName = (pid: number): string | null =>
  execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).match(/^"([^"]+)"/m)?.[1] ?? null

/** How a left-over process is looked up and killed; tests stand in for it */
export type ProcessLookup = { name(pid: number): string | null; kill(pid: number): void }
const realLookup: ProcessLookup = {
  name: (pid) => { try { return process.platform === 'win32' ? windowsName(pid) : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() || null } catch { return null } },
  kill: (pid) => { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } },
}

/**
 * A whisper-server left over from a Yogurt that was killed would hold memory and a port forever.
 * The pid file names it; it is killed only if that pid is still a program called whisper-server (pids get reused).
 */
export function killStale(pidFile: string, deps: ProcessLookup = realLookup) {
  let pid = NaN
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { return }
  rmSync(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 1) return
  const name = deps.name(pid)
  if (name && basename(name).replace(/\.exe$/i, '') === 'whisper-server') deps.kill(pid)
}

type Opts = {
  binary: string
  model: string
  /** the VAD model: whisper skips what isn't speech */
  vadModel?: string
  /** how long loading the model may take before giving up (it takes seconds) */
  startTimeoutMs?: number
  threads?: number
  /** where the running program's pid is kept, so a later start can clean up after a crash */
  pidFile?: string
  lookup?: ProcessLookup
  /** the wait before each relaunch in a meeting (tests: none) */
  backoffMs?: number[]
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /**
   * Windows and Linux: a server that dies while loading is most likely a graphics driver failing under Vulkan, so every
   * launch after that runs on the processor (-ng): slower, but it works. A Mac never needs it (Metal).
   */
  gpuFallback?: boolean
  /** told once when that happens (the speed check measured with the graphics, so it times again on the next start) */
  onGpuOff?: () => void
}

/** a meeting relaunches a dead or hung server at most this often, waiting longer each time */
export const RELAUNCH_BACKOFF_MS = [1000, 5000, 15_000]
/** this long without trouble since the last relaunch, and the relaunches are all there again */
export const HEALTHY_RESET_MS = 10 * 60_000

export function createWhisperServer(o: Opts) {
  let child: ChildProcess | null = null
  let starting: Promise<string> | null = null
  let address: string | null = null
  let launches = 0
  /** the address of the newest launch (known before it has loaded); a request tells which launch it used by this */
  let launchUrl: string | null = null
  const backoff = o.backoffMs ?? RELAUNCH_BACKOFF_MS
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  /** relaunches used in this meeting, and when the last one was */
  let used = 0
  let lastRelaunch = 0
  /** the program went away without being asked to */
  let died = false
  /** a launch died before it answered, with gpuFallback: the graphics stay off from now on */
  let cpuOnly = false

  const launch = async (): Promise<string> => {
    if (o.pidFile) { mkdirSync(dirname(o.pidFile), { recursive: true }); killStale(o.pidFile, o.lookup) }
    const port = await freePort()
    // beam 5, as in the model eval
    // 4 threads, never more than the computer has: with more, ggml's spinning threads made whisper 5 to 200 times slower
    const args = ['-m', o.model, '--host', '127.0.0.1', '--port', String(port), '-t', String(o.threads ?? Math.min(4, availableParallelism())), '-bs', '5']
    if (o.vadModel) args.push('--vad', '-vm', o.vadModel)
    if (cpuOnly) args.push('-ng')
    const p = spawn(o.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    launches++
    child = p
    died = false
    if (o.pidFile && p.pid) writeFileSync(o.pidFile, String(p.pid))
    let err = ''
    p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000) })
    const gone = new Promise<never>((_, reject) => {
      p.once('error', (e) => reject(new Error(`whisper-server could not start: ${e.message}`)))
      p.once('exit', (code, sig) => reject(new Error(`whisper-server exited (${code ?? sig}) ${err.split('\n').filter(Boolean).slice(-2).join(' | ')}`.trim())))
    })
    gone.catch(() => {})
    p.once('exit', () => {
      if (child === p) { child = null; address = null; died = true }
      if (o.pidFile) { try { if (Number(readFileSync(o.pidFile, 'utf8')) === p.pid) rmSync(o.pidFile, { force: true }) } catch { /* no file */ } }
    })
    const url = `http://127.0.0.1:${port}`
    launchUrl = url
    const healthy = (async () => {
      const deadline = Date.now() + (o.startTimeoutMs ?? 90_000)
      while (Date.now() < deadline) {
        try { if ((await fetch(url + '/', { signal: AbortSignal.timeout(2000) })).ok) return url } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150))
      }
      throw new Error('whisper-server did not start in time')
    })()
    try { return await Promise.race([healthy, gone]) } catch (e) {
      healthy.catch(() => {})
      if (o.gpuFallback && !cpuOnly && (p.exitCode !== null || p.signalCode !== null)) { cpuOnly = true; console.error('whisper-server stopped while loading; starting it again without the graphics card'); o.onGpuOff?.() }
      p.kill('SIGKILL')
      throw e
    }
  }

  const self = {
    get running() { return !!child && !!address },
    /** how many times the program has been started */
    get launches() { return launches },
    /** it runs without the graphics card from now on (gpuFallback) */
    get cpuOnly() { return cpuOnly },
    /**
     * The address, starting the server if it is not running. A first start is free; starting again after the program
     * died or was killed uses one of the meeting's relaunches (3, each after a longer wait; all back after 10 minutes
     * without trouble). Once they are spent this throws instead of trying again.
     */
    url(): Promise<string> {
      if (address && child) return Promise.resolve(address)
      if (starting) return starting
      let wait = 0
      if (died) {
        if (used && now() - lastRelaunch >= HEALTHY_RESET_MS) used = 0
        if (used >= backoff.length) return Promise.reject(new Error('whisper-server stopped and will not be started again this meeting'))
        wait = backoff[used]
        used++
        lastRelaunch = now()
      }
      starting = (wait ? sleep(wait) : Promise.resolve()).then(launch).then((u) => { address = u; return u }).finally(() => { starting = null })
      return starting
    },
    /** a new meeting: all relaunches again */
    resetBudget() { used = 0 },
    /**
     * It hangs or died: kill it and start another (the same relaunch as after a crash). `used` is the address the failed
     * request went to; if a newer launch exists or is starting, another request already did this, so just wait for that one.
     */
    async wedged(used?: string): Promise<string> {
      if (used === undefined || starting || launchUrl !== used) return self.url()
      const p = child
      if (p) { child = null; address = null; p.kill('SIGKILL') }
      died = true
      return self.url()
    },
    /** does the server at this address (default: the current one) answer? */
    async alive(at?: string): Promise<boolean> {
      const a = at ?? address
      if (!a) return false
      try { return (await fetch(a + '/', { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
    },
    /** hard stop, for quitting (no waiting) */
    kill() { child?.kill('SIGKILL') },
    async stop(): Promise<void> {
      await starting?.catch(() => {})
      const p = child
      child = null; address = null; died = false
      // only our own pid: a newer server may have written its own
      if (o.pidFile && p?.pid) { try { if (Number(readFileSync(o.pidFile, 'utf8')) === p.pid) rmSync(o.pidFile, { force: true }) } catch { /* no file */ } }
      if (!p || p.exitCode !== null || p.signalCode) return
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => p.kill('SIGKILL'), 3000)
        p.once('exit', () => { clearTimeout(t); resolve() })
        p.kill('SIGTERM')
      })
    },
  }
  return self
}
export type WhisperServer = ReturnType<typeof createWhisperServer>

/** What the transcriber does when a request fails: a timeout means it hung, anything else is checked with a ping */
export const recoverer = (srv: WhisperServer) => async (reason: 'gone' | 'timeout', used?: string): Promise<boolean> => {
  try {
    if (reason === 'gone' && used && (await srv.alive(used))) return true
    await srv.wedged(used)
    return true
  } catch (e) {
    console.error('whisper-server could not be brought back', e)
    return false
  }
}
