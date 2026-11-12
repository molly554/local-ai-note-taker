import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { closeSync, createWriteStream, mkdirSync, openSync, writeSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { pack, packPortable, unpack, unpackPortable } from '../src/main/zip'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
beforeEach(() => vi.resetAllMocks())

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-zip-')); dirs.push(d); return d }
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** every file under dir, as relative paths with / */
function tree(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? [`${r}/`, ...tree(dir, r)] : [r]
  }).sort()
}

const voice = randomBytes(300_000), them = randomBytes(200_000)
/** a backup-shaped folder: both audio formats, spaces, names in other scripts, an empty folder */
function sample(): string {
  const d = tmp(), m = join(d, 'meetings', 'm1')
  mkdirSync(join(m, 'original'), { recursive: true })
  mkdirSync(join(m, 'Réunion d’équipe 会議'))
  mkdirSync(join(d, 'meetings', 'empty'))
  writeFileSync(join(d, 'manifest.json'), '{"format":1}')
  writeFileSync(join(m, 'me.m4a'), voice)
  writeFileSync(join(m, 'them.ogg'), them)
  writeFileSync(join(m, 'me.1.ogg'), 'part')
  writeFileSync(join(m, 'original', 'me source.m4a'), 'source')
  writeFileSync(join(m, 'Réunion d’équipe 会議', 'ملاحظات ü.txt'), 'hello')
  return d
}
const expected = ['manifest.json', 'meetings/', 'meetings/empty/', 'meetings/m1/', 'meetings/m1/Réunion d’équipe 会議/', 'meetings/m1/Réunion d’équipe 会議/ملاحظات ü.txt',
  'meetings/m1/me.1.ogg', 'meetings/m1/me.m4a', 'meetings/m1/original/', 'meetings/m1/original/me source.m4a', 'meetings/m1/them.ogg'].sort()
function same(out: string) {
  expect(tree(out)).toEqual(expected)
  expect(readFileSync(join(out, 'meetings/m1/me.m4a'))).toEqual(voice)
  expect(readFileSync(join(out, 'meetings/m1/them.ogg'))).toEqual(them)
  expect(readFileSync(join(out, 'meetings/m1/Réunion d’équipe 会議/ملاحظات ü.txt'), 'utf8')).toBe('hello')
}

/** a zip written entry by entry, for archives a normal folder can't make */
async function rawZip(entries: Array<{ name: string; data?: string; mode?: number }>, zip64 = false): Promise<string> {
  const z = new yazl.ZipFile(), out = join(tmp(), 'raw.zip')
  for (const e of entries) z.addBuffer(Buffer.from(e.data ?? 'x'), e.name, { forceZip64Format: zip64, ...(e.mode ? { mode: e.mode } : {}) })
  z.end({ forceZip64Format: zip64, comment: "" })
  await pipeline(z.outputStream, createWriteStream(out))
  return out
}
/** yazl refuses unsafe names, so write a safe one of the same length and swap the bytes in both headers */
async function evilZip(safe: string, evil: string): Promise<string> {
  const file = await rawZip([{ name: 'manifest.json' }, { name: safe }])
  const bytes = readFileSync(file), a = Buffer.from(safe), b = Buffer.from(evil)
  expect(a.length).toBe(b.length)
  for (let i = bytes.indexOf(a); i >= 0; i = bytes.indexOf(a, i + 1)) b.copy(bytes, i)
  writeFileSync(file, bytes)
  return file
}

describe('backup zip, everywhere', () => {
  it('packs and unpacks a folder unchanged: both audio formats, spaces and names in other scripts', async () => {
    const zip = join(tmp(), 'Yogurt backup.zip'), out = tmp()
    await packPortable(sample(), zip)
    await unpackPortable(zip, out)
    same(out)
  })

  it('streams a large recording through without changing a byte', async () => {
    const src = tmp(), zip = join(tmp(), 'big.zip'), out = tmp()
    const big = Buffer.alloc(48 * 1024 * 1024)
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i)
    writeFileSync(join(src, 'them.ogg'), big)
    await packPortable(src, zip)
    await unpackPortable(zip, out)
    expect(readFileSync(join(out, 'them.ogg')).equals(big)).toBe(true)
  })

  it('restores a backup made on a Mac: its names come out right and the Mac-only extras stay out', async () => {
    const out = tmp()
    await unpackPortable(join(import.meta.dirname, 'fixtures', 'ditto-backup.zip'), out)
    expect(tree(out)).toEqual(['manifest.json', 'meetings/', 'meetings/m1/', 'meetings/m1/Réunion d’équipe 会議/', 'meetings/m1/Réunion d’équipe 会議/notes ü.txt',
      'meetings/m1/me.m4a', 'meetings/m1/original/', 'meetings/m1/original/me source.m4a', 'meetings/m1/them.ogg'])
    expect(readFileSync(join(out, 'meetings/m1/Réunion d’équipe 会議/notes ü.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(out, 'meetings/m1/them.ogg'), 'utf8')).toBe('them opus')
  })

  it.each([
    ['a step out of the folder', 'aa/evil.txt', '../evil.txt'],
    ['a deeper step out', 'meetings/aaaaa/x', 'meetings/../../x'],
    ['an absolute path', 'xtmp/evil.txt', '/tmp/evil.txt'],
    ['a Windows drive', 'xC/evil.txt', 'C:/evil.txt'],
    ['a backslash step out', 'aa/evil.txt', '..\\evil.txt'],
  ])('refuses an archive with %s, writing nothing outside', async (_why, safe, evil) => {
    const root = tmp(), out = join(root, 'out')
    mkdirSync(out)
    await expect(unpackPortable(await evilZip(safe, evil), out)).rejects.toThrow(/unsafe/)
    expect(readdirSync(root)).toEqual(['out'])
  })

  it('leaves links out: they could point anywhere on the computer', async () => {
    const out = tmp()
    await unpackPortable(await rawZip([{ name: 'manifest.json' }, { name: 'meetings/m1/me.m4a', data: '/etc/passwd', mode: 0o120777 }]), out)
    expect(tree(out)).toEqual(['manifest.json'])
  })

  // ditto has no ZIP64 and keeps only the low 32 bits of offsets past 4 GB. A sparse file makes one without writing 4 GB
  // (NTFS fills the gap for real, so not on Windows; the reader is the same code there)
  it.skipIf(process.platform === 'win32')('restores a Mac backup over 4 GB, which ditto writes without ZIP64', async () => {
    const zip = join(tmp(), 'big.zip'), out = tmp(), fd = openSync(zip, 'w')
    const entries: Array<{ name: string; data: Buffer; method: number; at: number; size: number; crc: number }> = []
    let at = 0
    const add = (name: string, data: Buffer, size = data.length, method = 0, crc = crc32(data)) => {
      const n = Buffer.from(name), h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(method, 8); h.writeUInt32LE(crc, 14)
      h.writeUInt32LE(data.length, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(n.length, 26)
      writeSync(fd, Buffer.concat([h, n, data]), 0, 30 + n.length + data.length, at)
      entries.push({ name, data, method, at, size, crc })
      at += 30 + n.length + (name.startsWith('__MACOSX/') ? size : data.length)
    }
    // the gap: a Mac extra the reader skips, nearly 4 GB of nothing
    add('__MACOSX/._pad', Buffer.alloc(0), 0xfffffff0, 0, 0)
    add('manifest.json', Buffer.from('{"format":1}'))
    add('meetings/m1/them.ogg', deflateRawSync(Buffer.from('opus '.repeat(100))), 500, 8, crc32(Buffer.from('opus '.repeat(100))))
    const cd = Buffer.concat(entries.map((e) => {
      const n = Buffer.from(e.name), c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(e.method, 10); c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.name.startsWith('__MACOSX/') ? e.size : e.data.length, 20); c.writeUInt32LE(e.size, 24); c.writeUInt16LE(n.length, 28)
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(e.at % 2 ** 32, 42)
      return Buffer.concat([c, n])
    }))
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at % 2 ** 32, 16)
    writeSync(fd, Buffer.concat([cd, end]), 0, cd.length + 22, at)
    closeSync(fd)
    expect(at).toBeGreaterThan(2 ** 32)
    await unpackPortable(zip, out)
    expect(tree(out)).toEqual(['manifest.json', 'meetings/', 'meetings/m1/', 'meetings/m1/them.ogg'])
    expect(readFileSync(join(out, 'meetings/m1/them.ogg'), 'utf8')).toBe('opus '.repeat(100))
  })

  it('refuses a name twice rather than writing over the first', async () => {
    await expect(unpackPortable(await rawZip([{ name: 'manifest.json' }, { name: 'manifest.json' }]), tmp())).rejects.toThrow()
  })

  it('reports a file that is not a zip as an error', async () => {
    const f = join(tmp(), 'not.zip')
    writeFileSync(f, 'not a zip at all')
    await expect(unpackPortable(f, tmp())).rejects.toThrow()
  })

  it('pack and unpack round-trip on this computer, whichever way it zips', async () => {
    const zip = join(tmp(), 'b.zip'), out = tmp()
    await pack(sample(), zip)
    await unpack(zip, out)
    same(out)
  })
})

// the Mac zips with ditto: archives must cross both ways
describe.skipIf(process.platform !== 'darwin')('backup zip, Mac and the others', () => {
  it('ditto archives unpack with the portable reader', async () => {
    const zip = join(tmp(), 'mac.zip'), out = tmp()
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', sample(), zip])
    await unpackPortable(zip, out)
    same(out)
  })

  it('portable archives unpack with ditto', async () => {
    const zip = join(tmp(), 'win.zip'), out = tmp()
    await packPortable(sample(), zip)
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
    same(out)
  })

  // past 4 GB a Windows or Linux backup needs ZIP64, which ditto can't read
  it('falls back to the portable reader when ditto fails on a ZIP64 archive, and only then', async () => {
    const fail = () => vi.mocked(execFile).mockImplementationOnce((...args) => {
      (args.at(-1) as (e: Error) => void)(new Error("ditto: Couldn't read pkzip signature."))
      return {} as ReturnType<typeof execFile>
    })
    const out = tmp()
    writeFileSync(join(out, 'partial'), 'left by ditto')
    fail()
    await unpack(await rawZip([{ name: 'manifest.json', data: '{}' }, { name: 'meetings/m1/me.ogg', data: 'opus' }], true), out)
    expect(tree(out)).toEqual(['manifest.json', 'meetings/', 'meetings/m1/', 'meetings/m1/me.ogg'])
    fail()
    await expect(unpack(await rawZip([{ name: 'manifest.json' }]), tmp())).rejects.toThrow('pkzip')
  })

  it('pack is ditto on a Mac, with a sequestered resource folder', async () => {
    const src = sample(), zip = join(tmp(), 'mac.zip')
    execFileSync('/usr/bin/xattr', ['-w', 'com.yogurt.test', '1', join(src, 'manifest.json')])
    await pack(src, zip)
    expect(execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' })).toContain('__MACOSX/')
  })
})
