import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createInflateRaw, crc32 } from 'node:zlib'
import yauzl from 'yauzl'
import yazl from 'yazl'

/**
 * The backup zip. A Mac zips with ditto, as it always has. Windows and Linux write and read the same plain zip in
 * JavaScript, streamed, so a backup made on one computer restores on any other.
 */
const run = promisify(execFile)
const mac = process.platform === 'darwin'

/** dir's contents (not dir itself) into the zip at out */
export async function pack(dir: string, out: string): Promise<void> {
  if (mac) await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', dir, out])
  else await packPortable(dir, out)
}

/** the zip's contents into dir */
export async function unpack(zip: string, dir: string): Promise<void> {
  if (!mac) return unpackPortable(zip, dir)
  try {
    await run('/usr/bin/ditto', ['-x', '-k', zip, dir])
  } catch (e) {
    // ditto can't read ZIP64, which Windows and Linux backups use past 4 GB: those are read here instead
    if ((await ends(zip).catch(() => 'other')) !== 'zip64') throw e
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir)
    await unpackPortable(zip, dir)
  }
}

// recordings are already compressed: storing them as they are is as small and much faster
const stored = /\.(m4a|ogg|wav)$/i

export async function packPortable(dir: string, out: string): Promise<void> {
  const zip = new yazl.ZipFile()
  const failed = new Promise<never>((_, reject) => zip.on('error', reject))
  const written = pipeline(zip.outputStream, createWriteStream(out))
  const add = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { zip.addEmptyDirectory(r); await add(r) }
      else if (e.isFile()) zip.addFile(join(dir, r), r, { compress: !stored.test(r) })
    }
  }
  try { await add('') } finally { zip.end() }
  await Promise.race([written, failed])
}

/**
 * a name inside the archive as a path inside dir, or an error for one that would land anywhere else (zip slip).
 * No backslash or colon either: Windows reads those as folders, drives and hidden streams.
 */
function inside(dir: string, name: string): string {
  const parts = name.split('/')
  if (/[\\:\0]/.test(name) || name.startsWith('/') || parts.includes('..')) throw new Error(`unsafe name in backup: ${name}`)
  const path = resolve(dir, ...parts)
  if (relative(resolve(dir), path).split(sep).includes('..')) throw new Error(`unsafe name in backup: ${name}`)
  return path
}
const S_IFMT = 0o170000, S_IFLNK = 0o120000

/** where one entry goes in dir, or undefined for one that stays out; folders are made here */
async function place(dir: string, raw: Buffer, attributes: number): Promise<string | undefined> {
  // ditto writes UTF-8 names without the flag that says so, which the spec would read as an old DOS code page
  const name = raw.toString('utf8')
  const path = inside(dir, name)
  // a Mac's extended attributes, which only ditto puts back
  if (name.startsWith('__MACOSX/')) return undefined
  // only plain files and folders come out of a backup: a link could point anywhere on the computer
  if (((attributes >>> 16) & S_IFMT) === S_IFLNK) return undefined
  if (name.endsWith('/')) { await mkdir(path, { recursive: true }); return undefined }
  await mkdir(resolve(path, '..'), { recursive: true })
  return path
}
// wx: a name that comes twice is refused, never written over
const write = (from: Readable, path: string, ...through: Transform[]) => pipeline([from, ...through, createWriteStream(path, { flags: 'wx' })])

const FOUR_GB = 2 ** 32
export async function unpackPortable(file: string, dir: string): Promise<void> {
  if (await dittoOver4GB(file)) return unpackDittoOver4GB(file, dir)
  // autoClose (the default) closes the file when the loop ends, by error too. Names are checked in place(), not by yauzl
  const zip = await yauzl.openPromise(file, { lazyEntries: true, decodeStrings: false })
  for await (const entry of zip.eachEntry()) {
    const path = await place(dir, entry.fileNameRaw, entry.externalFileAttributes)
    if (path) await write(await zip.openReadStreamPromise(entry), path)
  }
}

/**
 * ditto has no ZIP64: past 4 GB it keeps only the low 32 bits of each offset, which a reader that follows the spec
 * (yauzl) can't open. A big Mac backup is such a file: over 4 GB with no ZIP64 record before its end record.
 */
async function dittoOver4GB(file: string): Promise<boolean> {
  return (await stat(file)).size >= FOUR_GB && (await ends(file)) === 'plain'
}
/** how a zip with no comment ends: its end record alone, or with the ZIP64 locator right before it */
async function ends(file: string): Promise<'plain' | 'zip64' | 'other'> {
  const size = (await stat(file)).size
  if (size < 42) return 'other'
  const tail = await readAt(file, size - 42, 42)
  if (tail.readUInt32LE(20) !== 0x06054b50) return 'other'
  return tail.readUInt32LE(0) === 0x07064b50 ? 'zip64' : 'plain'
}
async function readAt(file: string, at: number, length: number): Promise<Buffer> {
  const fh = await open(file, 'r')
  try {
    const b = Buffer.alloc(length)
    const { bytesRead } = await fh.read(b, 0, length, at)
    return b.subarray(0, bytesRead)
  } finally { await fh.close() }
}

/** reads such a file from its central directory, finding each true offset by adding back whole 4 GBs */
async function unpackDittoOver4GB(file: string, dir: string): Promise<void> {
  const size = (await stat(file)).size
  const end = await readAt(file, size - 22, 22)
  const count = end.readUInt16LE(10), cdSize = end.readUInt32LE(12)
  // ditto writes no archive comment, so the central directory sits right before the 22-byte end record
  const cdStart = size - 22 - cdSize
  const cd = await readAt(file, cdStart, cdSize)
  for (let i = 0, p = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('not a backup: broken central directory')
    const method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16), packed = cd.readUInt32LE(p + 20), length = cd.readUInt32LE(p + 24)
    const n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), k = cd.readUInt16LE(p + 32)
    const attributes = cd.readUInt32LE(p + 38), stored = cd.readUInt32LE(p + 42)
    const raw = cd.subarray(p + 46, p + 46 + n)
    p += 46 + n + m + k
    const path = await place(dir, raw, attributes)
    if (!path) continue
    if (method !== 0 && method !== 8) throw new Error('not a backup: unknown compression')
    let data: number | undefined
    for (let at = stored; at < cdStart && data === undefined; at += FOUR_GB) {
      const h = await readAt(file, at, 30 + n)
      if (h.length === 30 + n && h.readUInt32LE(0) === 0x04034b50 && h.subarray(30).equals(raw)) data = at + 30 + n + h.readUInt16LE(28)
    }
    if (data === undefined) throw new Error('not a backup: missing entry')
    let sum = 0, bytes = 0
    const check = new Transform({
      transform(chunk: Buffer, _e, done) { sum = crc32(chunk, sum); bytes += chunk.length; done(null, chunk) },
      // sizes past 4 GB are cut to 32 bits here too, so compare those bits
      flush(done) { done(sum === crc && bytes % FOUR_GB === length ? null : new Error('backup entry is damaged')) },
    })
    const from = packed ? createReadStream(file, { start: data, end: data + packed - 1 }) : Readable.from([])
    await (method === 8 ? write(from, path, createInflateRaw(), check) : write(from, path, check))
  }
}
