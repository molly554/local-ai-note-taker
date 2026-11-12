import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { audioExts, createAudioHandler, parseRange, trackFile } from '../src/main/audio'

const ID = '3f2b8c1e-7d4a-4c9b-9e1f-0a1b2c3d4e5f'
function setup(o: { known?: (id: string) => boolean; ready?: () => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-audio-'))
  const dirOf = (id: string) => join(root, 'meetings', id)
  mkdirSync(dirOf(ID), { recursive: true })
  writeFileSync(join(dirOf(ID), 'me.m4a'), Buffer.from('0123456789'))
  writeFileSync(join(dirOf(ID), 'them.m4a'), Buffer.from('abcdefghij'))
  writeFileSync(join(root, 'secret.m4a'), 'secret')
  const handle = createAudioHandler({ dirOf, known: o.known ?? ((id) => id === ID), ready: o.ready ?? (async () => {}), exts: ['m4a'] })
  return { root, handle }
}
const get = (handle: (r: Request) => Promise<Response>, url: string, range?: string) =>
  handle(new Request(url, range ? { headers: { Range: range } } : undefined))

describe('parseRange', () => {
  it('reads a start and end', () => expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 }))
  it('reads an open end', () => expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 }))
  it('reads the last n bytes', () => expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 }))
  it('clamps an end past the file', () => expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 }))
  it('has no range without the header', () => expect(parseRange(null, 10)).toBeNull())
  it('refuses a start past the file', () => expect(parseRange('bytes=10-', 10)).toBe('bad'))
  it('refuses nonsense', () => {
    expect(parseRange('bytes=5-2', 10)).toBe('bad')
    expect(parseRange('items=0-1', 10)).toBe('bad')
    expect(parseRange('bytes=-0', 10)).toBe('bad')
  })
})

describe('the yogurt-audio protocol', () => {
  it('serves a whole track, saying it can serve parts', async () => {
    const { handle } = setup()
    const r = await get(handle, `yogurt-audio://${ID}/me`)
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('content-type')).toBe('audio/mp4')
    expect(r.headers.get('content-length')).toBe('10')
    expect(await r.text()).toBe('0123456789')
  })
  it('serves the part asked for, so seeking works', async () => {
    const { handle } = setup()
    const r = await get(handle, `yogurt-audio://${ID}/them`, 'bytes=2-4')
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(r.headers.get('content-length')).toBe('3')
    expect(await r.text()).toBe('cde')
  })
  it('says when a part is past the end', async () => {
    const { handle } = setup()
    const r = await get(handle, `yogurt-audio://${ID}/them`, 'bytes=20-')
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */10')
  })
  it('serves only the two tracks of a meeting it knows', async () => {
    const { handle } = setup()
    const other = '00000000-0000-4000-8000-000000000000'
    for (const url of [
      `yogurt-audio://${ID}/secret`, `yogurt-audio://${ID}/me.m4a`, `yogurt-audio://${ID}/../secret`, `yogurt-audio://${ID}/%2e%2e%2fsecret`,
      `yogurt-audio://${ID}/me/extra`, `yogurt-audio://${other}/me`, 'yogurt-audio://../me', `yogurt-audio://${ID}%2f..%2f..%2f/me`,
    ]) {
      const r = await get(handle, url)
      expect([r.status, url]).toEqual([404, url])
    }
  })
  it('waits for the recording to be finished before reading it', async () => {
    let done!: () => void
    const ready = new Promise<void>((r) => { done = r })
    const { handle } = setup({ ready: () => ready })
    let answered = false
    const p = get(handle, `yogurt-audio://${ID}/me`).then((r) => { answered = true; return r })
    await new Promise((r) => setTimeout(r, 20))
    expect(answered).toBe(false)
    done()
    expect((await p).status).toBe(200)
  })
  it('says not found for a track that was never written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-audio-'))
    const handle = createAudioHandler({ dirOf: (id) => join(root, id), known: () => true, ready: async () => {}, exts: ['m4a'] })
    expect((await get(handle, `yogurt-audio://${ID}/me`)).status).toBe(404)
  })
})

describe('recordings from either kind of computer', () => {
  it('a Mac records m4a, Windows and Linux record Ogg Opus; each plays the other\'s too, its own first', () => {
    expect(audioExts('darwin', false)).toEqual(['m4a', 'ogg'])
    expect(audioExts('win32', false)).toEqual(['ogg', 'm4a'])
    expect(audioExts('linux', false)).toEqual(['ogg', 'm4a'])
    expect(audioExts('darwin', true)).toEqual(['wav'])
  })
  it('serves an Ogg recording as audio/ogg, and a Mac backup\'s m4a beside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-audio-'))
    mkdirSync(join(root, ID))
    writeFileSync(join(root, ID, 'me.ogg'), 'OggS-me')
    writeFileSync(join(root, ID, 'them.m4a'), 'mac-them')
    const handle = createAudioHandler({ dirOf: (id) => join(root, id), known: () => true, ready: async () => {}, exts: audioExts('win32', false) })
    const me = await get(handle, `yogurt-audio://${ID}/me`)
    expect([me.status, me.headers.get('content-type'), await me.text()]).toEqual([200, 'audio/ogg', 'OggS-me'])
    const them = await get(handle, `yogurt-audio://${ID}/them`)
    expect([them.status, them.headers.get('content-type'), await them.text()]).toEqual([200, 'audio/mp4', 'mac-them'])
    expect(trackFile(join(root, ID), 'me', ['ogg', 'm4a'])).toBe(join(root, ID, 'me.ogg'))
    expect(trackFile(join(root, ID), 'me', ['m4a'])).toBeNull()
  })
})

describe('a meeting restored from another computer', () => {
  it('a Mac plays a Windows or Linux meeting (Ogg Opus), and still prefers its own m4a', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-audio-'))
    mkdirSync(join(root, ID))
    writeFileSync(join(root, ID, 'me.ogg'), 'OggS-pc')
    writeFileSync(join(root, ID, 'them.ogg'), 'OggS-pc-them')
    writeFileSync(join(root, ID, 'them.m4a'), 'mac-them')
    const handle = createAudioHandler({ dirOf: (id) => join(root, id), known: () => true, ready: async () => {}, exts: audioExts('darwin', false) })
    const me = await get(handle, `yogurt-audio://${ID}/me`)
    expect([me.status, me.headers.get('content-type'), await me.text()]).toEqual([200, 'audio/ogg', 'OggS-pc'])
    const them = await get(handle, `yogurt-audio://${ID}/them`)
    expect([them.headers.get('content-type'), await them.text()]).toEqual(['audio/mp4', 'mac-them'])
  })
})
