import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class DiskSpaceError extends Error {
  name = 'DiskSpaceError'
  constructor(public needGB: number) { super(`Not enough disk space. Free up ${needGB} GB and try again.`) }
}
export class ChecksumError extends Error { name = 'ChecksumError' }

export type Progress = { fraction: number; etaSec: number }
export type EnsureOpts = {
  url: string; sha256: string; sizeGB: number; dir: string
  /** where the file goes inside dir (may be nested, like a model folder's files); the url's own name when left out */
  fileName?: string
  onProgress?: (p: Progress) => void; signal?: AbortSignal
}
export type DownloadDeps = {
  download(url: string, dir: string, fileName: string, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<void>
  hashFile(path: string): Promise<string>
  freeDiskGB(dir: string): Promise<number>
}

const DISK_HEADROOM_GB = 10

// plain names only: no "..", no leading dot or slash. Nested parts allowed for model folders
const SAFE_PART = /^(?!\.)[\w.-]+$/
const SAFE_URL_NAME = /^[\w.-]+\.(gguf|bin)$/

/** Throws on anything that could leave the models folder */
export function safeRelPath(p: string): string {
  const parts = p.split('/')
  if (!parts.every((x) => SAFE_PART.test(x) && x !== '..')) throw new Error(`Unsafe model file name: ${p}`)
  return p
}

/** Local file name for a model URL. Throws on anything that isn't a plain `.gguf` or `.bin` name. */
export function fileNameFor(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (!SAFE_URL_NAME.test(name) || name.startsWith('.')) throw new Error(`Unsafe model file name: ${name}`)
  return name
}
const marker = (dir: string, fileName: string) => join(dir, fileName + '.ok')
/** Disk already taken by an unfinished download of this file (it is reused, so it counts toward the need). */
export function partialDownloadGB(dir: string, fileName: string): number {
  try { return statSync(join(dir, fileName + '.part')).size / 1e9 } catch { return 0 }
}

export const isVerified = (dir: string, fileName: string, sha256?: string) => {
  if (!existsSync(join(dir, fileName)) || !existsSync(marker(dir, fileName))) return false
  return sha256 === undefined || readFileSync(marker(dir, fileName), 'utf8') === sha256
}

export const STALL_MS = 45_000
export const STALL_TRIES = 5

/**
 * Runs a download, restarting it when no data arrives for stallMs: connections can hang without failing,
 * which would otherwise wait forever. Each restart resumes from the partial file.
 */
export async function retryStalled(
  run: (signal: AbortSignal, progressed: () => void) => Promise<void>,
  o: { stallMs?: number; tries?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const stallMs = o.stallMs ?? STALL_MS
  const tries = o.tries ?? STALL_TRIES
  for (let attempt = 1; ; attempt++) {
    const ac = new AbortController()
    let stalled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const progressed = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort() }, stallMs) }
    const stop = () => ac.abort()
    o.signal?.addEventListener('abort', stop, { once: true })
    progressed()
    try {
      await run(ac.signal, progressed)
      return
    } catch (err) {
      if (o.signal?.aborted || !stalled) throw err
      if (attempt >= tries) throw new Error('The download stopped receiving data. Check your internet connection and try again.')
    } finally {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', stop)
    }
  }
}

/** Downloads into `<file>.part` and renames when whole; a later attempt continues from the part with a Range request. */
export async function fetchResumable(url: string, path: string, onProgress: (p: Progress) => void, signal: AbortSignal, progressed: () => void, fetchFn: typeof fetch = fetch) {
  const part = path + '.part'
  mkdirSync(dirname(path), { recursive: true })
  const have = existsSync(part) ? statSync(part).size : 0
  const res = await fetchFn(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal })
  // asked for bytes past the end: the part is already the whole file
  if (res.status === 416) { renameSync(part, path); return }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  const resumed = res.status === 206 && have > 0
  const start = resumed ? have : 0
  const total = start + Number(res.headers.get('content-length') ?? 0)
  let done = start
  const began = Date.now()
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    done += chunk.length
    progressed()
    const rate = (done - start) / Math.max(1, Date.now() - began) // bytes per ms
    onProgress({ fraction: total ? Math.min(1, done / total) : 0, etaSec: total && rate > 0 ? Math.round((total - done) / rate / 1000) : 0 })
  })
  await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal })
  renameSync(part, path)
}

export const realDeps: DownloadDeps = {
  async download(url, dir, fileName, onProgress, signal) {
    await retryStalled((attemptSignal, progressed) => fetchResumable(url, join(dir, fileName), onProgress, attemptSignal, progressed), { signal })
  },
  hashFile: (path) => new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  }),
  async freeDiskGB(dir) {
    mkdirSync(dir, { recursive: true })
    const s = await statfs(dir)
    return (s.bavail * s.bsize) / 1e9
  },
}

export async function ensureFile(opts: EnsureOpts, deps: DownloadDeps = realDeps): Promise<string> {
  const fileName = safeRelPath(opts.fileName ?? fileNameFor(opts.url))
  const path = join(opts.dir, fileName)
  if (isVerified(opts.dir, fileName, opts.sha256)) return path

  const free = await deps.freeDiskGB(opts.dir)
  const need = opts.sizeGB - partialDownloadGB(opts.dir, fileName) + DISK_HEADROOM_GB - free
  if (need > 0) throw new DiskSpaceError(Math.ceil(need))

  for (let attempt = 0; attempt < 2; attempt++) {
    await deps.download(opts.url, opts.dir, fileName, opts.onProgress ?? (() => {}), opts.signal)
    if ((await deps.hashFile(path)) === opts.sha256) {
      writeFileSync(marker(opts.dir, fileName), opts.sha256)
      return path
    }
    rmSync(path, { force: true })
  }
  throw new ChecksumError(`Download of ${fileName} was corrupted twice`)
}
