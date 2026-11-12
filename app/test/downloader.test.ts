import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChecksumError, ensureFile, fetchResumable, fileNameFor, isVerified, partialDownloadGB, retryStalled, safeRelPath, type DownloadDeps } from '../src/main/downloader'

const URL = 'https://huggingface.co/x/y/resolve/main/model-Q4.gguf'
const dir = () => mkdtempSync(join(tmpdir(), 'yogurt-dl-'))

function deps(over: Partial<DownloadDeps> = {}): DownloadDeps {
  return {
    download: vi.fn(async (_u, d, f, onProgress) => { onProgress({ fraction: 1, etaSec: 0 }); writeFileSync(join(d, f), 'data') }),
    hashFile: vi.fn(async () => 'good'),
    freeDiskGB: vi.fn(async () => 500),
    ...over,
  }
}

describe('ensureFile', () => {
  it('counts bytes of a partial download as already-used space when checking disk', async () => {
    const d = dir()
    writeFileSync(join(d, 'model-Q4.gguf.part'), Buffer.alloc(64 * 1024))
    const partial = partialDownloadGB(d, 'model-Q4.gguf')
    expect(partial).toBeGreaterThanOrEqual(64 * 1024 / 1e9)
    const dp = deps({ freeDiskGB: vi.fn(async () => 10 + 0.0001 - partial / 2) })
    await expect(ensureFile({ url: URL, sha256: 'good', sizeGB: 0.0001, dir: d }, dp)).resolves.toContain('model-Q4.gguf')
  })
  it('derives the file name from the url (.gguf and .bin)', () => {
    expect(fileNameFor(URL)).toBe('model-Q4.gguf')
    expect(fileNameFor('https://huggingface.co/a/b/resolve/main/ggml-small-q5_1.bin')).toBe('ggml-small-q5_1.bin')
  })
  it('downloads, verifies, writes the .ok marker', async () => {
    const d = dir(); const dp = deps()
    const p = await ensureFile({ url: URL, sha256: 'good', sizeGB: 1, dir: d }, dp)
    expect(p).toBe(join(d, 'model-Q4.gguf'))
    expect(isVerified(d, 'model-Q4.gguf')).toBe(true)
  })
  it('puts a file in a nested folder when asked', async () => {
    const d = dir()
    const p = await ensureFile({ url: 'https://x.test/a/weight.bin', sha256: 'good', sizeGB: 0.01, dir: d, fileName: 'Segmentation.mlmodelc/weights/weight.bin' }, { ...deps(), download: async (_u, base, f) => { const { mkdirSync } = await import('node:fs'); const { dirname } = await import('node:path'); mkdirSync(dirname(join(base, f)), { recursive: true }); writeFileSync(join(base, f), 'x') } })
    expect(p).toBe(join(d, 'Segmentation.mlmodelc/weights/weight.bin'))
    expect(isVerified(d, 'Segmentation.mlmodelc/weights/weight.bin', 'good')).toBe(true)
  })
  it('skips download and hashing when already verified', async () => {
    const d = dir()
    writeFileSync(join(d, 'model-Q4.gguf'), 'data'); writeFileSync(join(d, 'model-Q4.gguf.ok'), 'good')
    const dp = deps()
    await ensureFile({ url: URL, sha256: 'good', sizeGB: 1, dir: d }, dp)
    expect(dp.download).not.toHaveBeenCalled()
    expect(dp.hashFile).not.toHaveBeenCalled()
  })
  it('downloads again when the pinned hash changed', async () => {
    const d = dir()
    writeFileSync(join(d, 'model-Q4.gguf'), 'data'); writeFileSync(join(d, 'model-Q4.gguf.ok'), 'old')
    const dp = deps()
    await ensureFile({ url: URL, sha256: 'good', sizeGB: 1, dir: d }, dp)
    expect(dp.download).toHaveBeenCalledTimes(1)
  })
  it('refuses when disk is too small', async () => {
    const d = dir()
    await expect(ensureFile({ url: URL, sha256: 'good', sizeGB: 20, dir: d }, deps({ freeDiskGB: async () => 25 })))
      .rejects.toMatchObject({ name: 'DiskSpaceError', needGB: 5 })
  })
  it('retries once on checksum mismatch, then fails and deletes the file', async () => {
    const d = dir()
    const dp = deps({ hashFile: vi.fn(async () => 'bad') })
    await expect(ensureFile({ url: URL, sha256: 'good', sizeGB: 1, dir: d }, dp)).rejects.toBeInstanceOf(ChecksumError)
    expect(dp.download).toHaveBeenCalledTimes(2)
    expect(existsSync(join(d, 'model-Q4.gguf'))).toBe(false)
  })
  it('succeeds if the retry verifies', async () => {
    const d = dir()
    const hashes = ['bad', 'good']
    const dp = deps({ hashFile: vi.fn(async () => hashes.shift()!) })
    await ensureFile({ url: URL, sha256: 'good', sizeGB: 1, dir: d }, dp)
    expect(isVerified(d, 'model-Q4.gguf')).toBe(true)
  })
})

describe('file name safety', () => {
  it('rejects path traversal in the url', () => {
    expect(() => fileNameFor('https://huggingface.co/x/..%2F..%2Fetc%2Fpasswd')).toThrow()
  })
  it('rejects other file types', () => {
    expect(() => fileNameFor('https://huggingface.co/x/y/notes.txt')).toThrow()
  })
  it('rejects nested paths that climb out or start with a dot', () => {
    for (const bad of ['../x', 'a/../x', '/abs', 'a//b', '.hidden', 'a/.b', '']) expect(() => safeRelPath(bad)).toThrow()
    expect(safeRelPath('Embedding.mlmodelc/weights/weight.bin')).toBe('Embedding.mlmodelc/weights/weight.bin')
  })
})

describe('stalled downloads', () => {
  it('a download that stops receiving data is restarted (it resumes), then finishes', async () => {
    let calls = 0
    const run = (signal: AbortSignal, progressed: () => void) => new Promise<void>((resolve, reject) => {
      calls++
      if (calls === 1) { progressed(); signal.addEventListener('abort', () => reject(new Error('aborted'))); return }
      progressed(); resolve()
    })
    await retryStalled(run, { stallMs: 50, tries: 3 })
    expect(calls).toBe(2)
  })
  it('gives up after a few stalls with a plain error, and Stop still stops at once', async () => {
    const hang = (signal: AbortSignal) => new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    await expect(retryStalled(hang, { stallMs: 20, tries: 2 })).rejects.toThrow(/stopped receiving data/)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)
    let calls = 0
    await expect(retryStalled((s) => { calls++; return hang(s) }, { stallMs: 1000, tries: 3, signal: ac.signal })).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('fetchResumable (real HTTP, local server)', () => {
  const body = Buffer.from('0123456789'.repeat(1000))
  async function serve<T>(fn: (url: string, ranges: (string | undefined)[]) => Promise<T>) {
    const ranges: (string | undefined)[] = []
    const server = createServer((req, res) => {
      ranges.push(req.headers.range)
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
      const from = m ? Number(m[1]) : 0
      if (from >= body.length) { res.writeHead(416).end(); return }
      res.writeHead(m ? 206 : 200, { 'content-length': body.length - from })
      res.end(body.subarray(from))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try { return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}/f.bin`, ranges) } finally { server.close() }
  }
  it('downloads the whole file and reports progress up to 1', async () => {
    await serve(async (url) => {
      const d = dir(); const seen: number[] = []
      await fetchResumable(url, join(d, 'f.bin'), (p) => seen.push(p.fraction), new AbortController().signal, () => {})
      expect(readFileSync(join(d, 'f.bin')).equals(body)).toBe(true)
      expect(seen.at(-1)).toBe(1)
      expect(existsSync(join(d, 'f.bin.part'))).toBe(false)
    })
  })
  it('continues from a partial file with a Range request', async () => {
    await serve(async (url, ranges) => {
      const d = dir()
      writeFileSync(join(d, 'f.bin.part'), body.subarray(0, 4000))
      await fetchResumable(url, join(d, 'f.bin'), () => {}, new AbortController().signal, () => {})
      expect(ranges).toEqual(['bytes=4000-'])
      expect(readFileSync(join(d, 'f.bin')).equals(body)).toBe(true)
    })
  })
  it('treats a part that is already whole as done', async () => {
    await serve(async (url) => {
      const d = dir()
      writeFileSync(join(d, 'f.bin.part'), body)
      await fetchResumable(url, join(d, 'f.bin'), () => {}, new AbortController().signal, () => {})
      expect(readFileSync(join(d, 'f.bin')).equals(body)).toBe(true)
    })
  })
})
