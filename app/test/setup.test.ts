import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { speedKey, type Catalog, type Hardware } from '@yogurt/picker'
import bundled from '../../catalog/catalog.json'
import { SetupController, type SetupDeps, type SpeedDeps, type SpeedResult } from '../src/main/setup'
import { tooSlow } from '../src/main/localCheck'
import { fakeDownloadDeps } from '../src/main/fake'
import { DiskSpaceError, type DownloadDeps } from '../src/main/downloader'
import type { SetupState } from '../src/shared/types'

const catalog = bundled as unknown as Catalog
const m1max: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1 Max', totalRamGB: 32, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1 Max', vramGB: 24 } }
const mac8: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1', totalRamGB: 8.6, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1', vramGB: 6 } }

const name = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!)

/** a download that records what was asked for, and can hold chosen files back until released */
function recorder(hold: (url: string) => boolean = () => false) {
  const asked: string[] = []
  const released: (() => void)[] = []
  const inner = fakeDownloadDeps({ stepMs: 0 })
  const download: DownloadDeps['download'] = async (url, dir, file, onProgress, signal) => {
    asked.push(url)
    if (hold(url)) await new Promise<void>((r) => released.push(r))
    return inner.download(url, dir, file, onProgress, signal)
  }
  return { asked, release: () => released.splice(0).forEach((r) => r()), deps: { ...inner, download } as DownloadDeps }
}

function setup(over: Partial<SetupDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
  const rec = recorder()
  const deps: SetupDeps = { getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0, 0], ...over }
  const c = new SetupController(deps)
  const states: SetupState[] = []
  c.onState((s) => states.push(s))
  return { c, states, root, rec }
}

const starterUrl = catalog.models.find((m) => m.starter)!.builds[0].url
const bigUrl = catalog.models.find((m) => m.id === 'gemma-4-26b-a4b')!.builds[0].url
const embedUrl = catalog.embedding.url
const turboUrl = catalog.asr[0].url
const smallUrl = catalog.asr[1].url

describe('SetupController', () => {
  it('goes checking, downloading, ready; the fraction only goes up and ends at 1', async () => {
    const { c, states } = setup()
    expect(c.state.phase).toBe('checking')
    await c.start()
    await c.idle()
    expect(states[0].phase).toBe('checking')
    expect(states.some((s) => s.phase === 'downloading')).toBe(true)
    expect(states.at(-1)).toMatchObject({ phase: 'ready', fraction: 1 })
    const phases = states.map((s) => s.phase)
    expect(phases.indexOf('checking')).toBeLessThan(phases.indexOf('downloading'))
    expect(phases.indexOf('downloading')).toBeLessThan(phases.indexOf('ready'))
    const fractions = states.map((s) => s.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
  })

  it('fetches speech first, then the starter notes model, then the recommended one', async () => {
    const { c, rec } = setup()
    await c.start(); await c.idle()
    const files = rec.asked.map(name)
    const at = (u: string) => rec.asked.indexOf(u)
    expect(at(turboUrl)).toBe(0)
    expect(at(starterUrl)).toBeGreaterThan(at(turboUrl))
    expect(at(bigUrl)).toBeGreaterThan(at(starterUrl))
    expect(files).not.toContain(name(smallUrl))
  })

  it('is ready before the recommended notes model finishes, which keeps downloading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === bigUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    await c.start()
    expect(c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    await vi.waitFor(() => expect(rec.asked).toContain(bigUrl))
    expect(c.installed()?.recommendedLlm).toBeUndefined()
    rec.release()
    await c.idle()
    expect(c.installed()?.recommendedLlm).toMatch(/gemma-4-26B/)
  })

  it('is ready as soon as speech and the speaker models are in: the first notes model arrives after, and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === starterUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    const arrived: string[] = []
    c.onNotesModel(() => arrived.push(c.installed()!.llm!))
    await c.start()
    expect(c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(c.installed()?.asr).toBeTruthy()
    expect(c.installed()?.llm).toBeUndefined()
    await vi.waitFor(() => expect(rec.asked).toContain(starterUrl))
    rec.release()
    await vi.waitFor(() => expect(arrived).toHaveLength(1))
    expect(c.installed()?.llm).toMatch(/E4B/)
    await c.idle()
  })

  it('a first notes model that fails to download keeps being tried in the background; ready stays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let fails = 3
    const download: DownloadDeps['download'] = async (u, ...rest) => { if (u === starterUrl && fails-- > 0) throw new Error('fetch failed'); return inner.download(u, ...rest) }
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0], notesRetryMs: [0] })
    await c.start()
    expect(c.state.phase).toBe('ready')
    await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.llm).toMatch(/E4B/)
  })

  it('the embedding model (meaning search) comes after the first notes model and before the bigger one; ready never waits for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const rec = recorder((u) => u === embedUrl)
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0] })
    const arrived: string[] = []
    c.onEmbedModel(() => arrived.push(c.installed()!.embed!))
    await c.start()
    expect(c.state.phase).toBe('ready')
    await vi.waitFor(() => expect(rec.asked).toContain(embedUrl))
    expect(rec.asked.indexOf(embedUrl)).toBeGreaterThan(rec.asked.indexOf(starterUrl))
    expect(c.installed()?.embed).toBeUndefined()
    rec.release()
    await c.idle()
    expect(rec.asked.indexOf(bigUrl)).toBeGreaterThan(rec.asked.indexOf(embedUrl))
    expect(c.installed()?.embed).toMatch(/embed[\\/]embeddinggemma-300M-Q8_0\.gguf$/)
    expect(arrived).toEqual([c.installed()!.embed])
  })

  it('an embedding model that fails keeps being tried, and the bigger notes model does not wait for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const inner = fakeDownloadDeps({ stepMs: 0 })
    let fails = 5
    const asked: string[] = []
    const download: DownloadDeps['download'] = async (u, ...rest) => { asked.push(u); if (u === embedUrl && fails-- > 0) throw new Error('fetch failed'); return inner.download(u, ...rest) }
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0], notesRetryMs: [0] })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.recommendedLlm).toMatch(/gemma-4-26B/)
    expect(c.installed()?.embed).toMatch(/embeddinggemma/)
    expect(asked.filter((u) => u === embedUrl).length).toBe(6)
  })

  it('does not wait for a recommended model that fails: still ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yogurt-setup-'))
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const download: DownloadDeps['download'] = async (u, ...rest) => { if (u === bigUrl) throw new Error('fetch failed'); return inner.download(u, ...rest) }
    const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: { ...inner, download }, sha256Override: 'FAKE', retryDelaysMs: [0] })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
  })

  it('shows the first notes-model failure while recording stays ready, and retry wakes only the existing download loop', async () => {
    vi.useFakeTimers()
    let blocked = true, attempts = 0, active = 0, peak = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const download: DownloadDeps = {
      freeDiskGB: async () => 500,
      hashFile: async () => 'FAKE',
      download: async (url, dir, file, onProgress) => {
        if (url === starterUrl) { attempts++; active++; peak = Math.max(peak, active) }
        try {
          if (url === starterUrl) {
            onProgress({ fraction: 0.42, etaSec: 240 })
            if (blocked) throw new DiskSpaceError(4)
            await held
          }
          mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), 'fake')
        } finally { if (url === starterUrl) active-- }
      },
    }
    const { c, states } = setup({ download, retryDelaysMs: [], notesRetryMs: [60_000] })
    const arrived = vi.fn()
    c.onNotesModel(arrived)
    try {
      await c.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(c.state).toMatchObject({ phase: 'ready', notesError: 'Not enough disk space. Free up 4 GB and try again.' })
      expect(c.state.notesTotalBytes).toBeUndefined()
      expect(c.state.notesEtaSec).toBeUndefined()
      expect(c.installed()?.asr).toBeTruthy()
      expect(c.installed()?.llm).toBeUndefined()
      expect(attempts).toBe(1)
      blocked = false
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(2)
      expect(c.state).not.toHaveProperty('notesError', expect.any(String))
      expect(c.state.notesTotalBytes).toBeGreaterThan(0)
      // A resumed download can report the same percentage as before the failure.
      expect(c.state).toMatchObject({ notesFraction: 0.42, notesEtaSec: 240 })
      await Promise.all(Array.from({ length: 10 }, () => c.retry()))
      // The old automatic retry must not start another download while this one is active.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts).toBe(2)
      expect(peak).toBe(1)
      release()
      await c.idle()
      expect(c.installed()?.llm).toMatch(/E4B/)
      expect(arrived).toHaveBeenCalledOnce()
      expect(states.every((s) => s.phase !== 'error')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      blocked = false; release()
      await vi.advanceTimersByTimeAsync(60_000)
      await c.idle()
      vi.useRealTimers()
    }
  })

  it('an 8 GB Mac gets turbo speech and one notes model (the pick is smaller than the starter)', async () => {
    const { c, rec } = setup({ getHardware: async () => mac8 })
    await c.start(); await c.idle()
    expect(rec.asked[0]).toBe(turboUrl)
    expect(rec.asked).not.toContain(starterUrl)
    // the one notes model, then the embedding model
    expect(rec.asked.slice(1)).toEqual([expect.stringContaining('E4B-it-Q3_K_S'), embedUrl])
    expect(c.state.phase).toBe('ready')
  })

  it('a Mac with under 8 GB gets the small speech model', async () => {
    const { c, rec } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 6 }) })
    await c.start(); await c.idle()
    expect(rec.asked).toContain(smallUrl)
    expect(rec.asked).not.toContain(turboUrl)
  })

  it('a Mac too small for any notes model says so, as it always did', async () => {
    const { c, rec } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 4 }) })
    await c.start(); await c.idle()
    expect(c.state).toMatchObject({ phase: 'error', message: 'Lynote NoteTaker needs a Mac with at least 8 GB of memory.' })
    expect(rec.asked).toEqual([])
  })

  it('a Windows or Linux computer too small says everything runs on it, with no cloud to fall back on', async () => {
    for (const os of ['win32', 'linux'] as const) {
      const pc: Hardware = { os, arch: 'x64', cpuModel: 'Intel Core i3', totalRamGB: 4, freeDiskGB: 500, gpu: { kind: 'none', name: '', vramGB: 0 } }
      const { c, rec } = setup({ getHardware: async () => pc })
      await c.start(); await c.idle()
      expect(c.state).toMatchObject({ phase: 'error', message: "Lynote NoteTaker runs entirely on your computer, and this one isn't strong enough. It needs at least 8 GB of memory." })
      expect(rec.asked).toEqual([])
    }
  })

  it('falls back to small when turbo fails its checksum', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const hashFile = async (p: string) => (p.includes('large-v3-turbo') ? 'WRONG' : 'FAKE')
    const { c, rec } = setup({ download: { ...inner, hashFile } })
    void rec
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(c.installed()?.asr).toContain('ggml-small-q5_1.bin')
  })

  it('downloads nothing for the bundled whisper-server: ready does not wait on it', async () => {
    expect(catalog.whisperServer.bundled).toBe(true)
    const { c, rec } = setup()
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(rec.asked.filter((u) => /whisper-server/.test(u))).toEqual([])
  })

  it('finds everything already in place on the next start and downloads nothing', async () => {
    const first = setup()
    await first.c.start(); await first.c.idle()
    const again = setup({ modelsDir: first.root })
    await again.c.start(); await again.c.idle()
    expect(again.rec.asked).toEqual([])
    expect(again.c.state).toMatchObject({ phase: 'ready', fraction: 1 })
  })

  it('says so plainly when the disk is too full, and a retry works once there is room', async () => {
    let free = 5
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const { c } = setup({ download: { ...inner, freeDiskGB: async () => free } })
    await c.start()
    expect(c.state.phase).toBe('error')
    expect(c.state.message).toMatch(/Not enough disk space/)
    free = 500
    await c.retry(); await c.idle()
    expect(c.state.phase).toBe('ready')
  })

  it('shows a plain message when the network drops', async () => {
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const { c } = setup({ download: { ...inner, download: async () => { throw new Error('fetch failed') } } })
    await c.start()
    expect(c.state).toMatchObject({ phase: 'error' })
    expect(c.state.message).toMatch(/connection/)
  })

  it('errors when there is no notes model this Mac can run', async () => {
    const { c } = setup({ getHardware: async () => ({ ...mac8, totalRamGB: 2 }) })
    await c.start()
    expect(c.state.phase).toBe('error')
  })

  it('ignores a second start while one is running', async () => {
    const { c, rec } = setup()
    await Promise.all([c.start(), c.start()])
    await c.idle()
    expect(rec.asked.filter((u) => u === turboUrl)).toHaveLength(1)
  })

  it('a finished install is ready at once and never shows downloading', async () => {
    const first = setup()
    await first.c.start(); await first.c.idle()
    const again = setup({ modelsDir: first.root })
    await again.c.start()
    expect(again.c.state).toMatchObject({ phase: 'ready', fraction: 1 })
    expect(again.states.some((s) => s.phase === 'downloading')).toBe(false)
  })
})

describe('the speed check (Windows and Linux): speech models timed on this computer', () => {
  const cpuPc: Hardware = { os: 'win32', arch: 'x64', cpuModel: 'Intel Core i5-1135G7', totalRamGB: 16, freeDiskGB: 500, gpu: { kind: 'none', name: '', vramGB: 0 }, cores: 8 }
  const gpuPc: Hardware = { os: 'linux', arch: 'x64', cpuModel: 'AMD Ryzen 5 5600X', totalRamGB: 16, freeDiskGB: 500, gpu: { kind: 'discrete', name: 'NVIDIA GeForce RTX 3060', vramGB: 12 }, cores: 12 }
  const url = (id: string) => catalog.asr.find((a) => a.id === id)!.url
  /** fake timings per model file, and a store kept in memory */
  function speed(rtf: Record<string, number | null>, saved?: SpeedResult) {
    const timed: string[] = []
    let stored = saved
    const deps: SpeedDeps = {
      measure: async (path) => { const id = Object.keys(rtf).find((k) => path.includes(catalog.asr.find((a) => a.id === k)!.url.split('/').pop()!))!; timed.push(id); return { rtf: rtf[id] } },
      load: () => stored, save: (r) => { stored = r },
    }
    return { deps, timed, stored: () => stored }
  }

  it('the first notes model shows progress on Windows, then clears it when installed', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.3 })
    const { c, states } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    const shown = states.filter((x) => x.phase === 'ready' && x.notesFraction !== undefined).map((x) => x.notesFraction)
    expect(shown).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(c.state.notesFraction).toBeUndefined()
    expect(c.installed()?.llm).toBeTruthy()
  })

  it('a Mac reports the same notes download progress', async () => {
    const { c, states } = setup()
    await c.start(); await c.idle()
    expect(states.filter(x => x.notesFraction !== undefined).map(x => x.notesFraction)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(c.state.notesFraction).toBeUndefined()
  })

  it('every system says the first notes model is still downloading, until it is in', async () => {
    for (const hw of [m1max, cpuPc, gpuPc]) {
      const { c, states } = setup({ getHardware: async () => hw })
      await c.start(); await c.idle()
      expect(states.some((x) => x.phase === 'ready' && x.notesDownloading && x.notesFraction === 0)).toBe(true)
      expect(states.some((x) => (x.notesFraction ?? 0) > 0)).toBe(true)
      expect(c.state.notesFraction).toBeUndefined()
      expect(c.state.notesDownloading).toBeUndefined()
    }
  })

  it.each([m1max, cpuPc, gpuPc])('passes the model size and downloader ETA through on $os, and clears both on completion', async hw => {
    const inner = fakeDownloadDeps({ stepMs: 0 }), requested: string[] = []
    const { c, states } = setup({ getHardware: async () => hw, download: {
      ...inner,
      download: (url, dir, file, onProgress, signal) => {
        requested.push(url)
        return inner.download(url, dir, file, p => onProgress({ ...p, etaSec: 240 }), signal)
      },
    } })
    await c.start(); await c.idle()
    const first = catalog.models.flatMap(m => m.builds).find(b => b.url === requested[1])!
    expect(states.find(s => s.notesFraction === 0)).toMatchObject({ notesTotalBytes: first.sizeGB * 1e9, notesEtaSec: undefined })
    expect(states.find(s => s.notesFraction === .5)).toMatchObject({ notesTotalBytes: first.sizeGB * 1e9, notesEtaSec: 240 })
    expect(c.state.notesTotalBytes).toBeUndefined()
    expect(c.state.notesEtaSec).toBeUndefined()
  })

  it('a Mac never runs it, even when it is offered: turbo as always, nothing timed or stored', async () => {
    const s = speed({ 'whisper-large-v3-turbo-q5_0': 9 })
    const { c, rec } = setup({ speed: s.deps })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(rec.asked[0]).toBe(turboUrl)
    expect(s.timed).toEqual([])
    expect(s.stored()).toBeUndefined()
  })

  it('on the processor alone: small first (never turbo), then smaller until one keeps up; the result is stored', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.88, 'whisper-base-q5_1': 0.42, 'whisper-tiny-q5_1': 0.19 })
    const { c, rec } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(s.timed).toEqual(['whisper-small-q5_1', 'whisper-base-q5_1'])
    expect(rec.asked).not.toContain(turboUrl)
    expect(rec.asked).not.toContain(url('whisper-tiny-q5_1'))
    expect(c.installed()?.asr).toContain('ggml-base-q5_1.bin')
    expect(s.stored()).toMatchObject({ key: speedKey(cpuPc), model: 'whisper-base-q5_1', rtf: { 'whisper-small-q5_1': 0.88, 'whisper-base-q5_1': 0.42 } })
  })

  it('with graphics turbo is timed first and kept when it keeps up', async () => {
    const s = speed({ 'whisper-large-v3-turbo-q5_0': 0.1 })
    const { c } = setup({ getHardware: async () => gpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual(['whisper-large-v3-turbo-q5_0'])
    expect(c.installed()?.asr).toContain('large-v3-turbo')
  })

  it('a stored result on the same computer is used as it is: nothing is timed again', async () => {
    const s = speed({}, { key: speedKey(cpuPc), model: 'whisper-tiny-q5_1', rtf: { 'whisper-tiny-q5_1': 0.2 }, at: 1 })
    const { c, rec } = setup({ getHardware: async () => cpuPc, speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual([])
    expect(rec.asked[0]).toBe(url('whisper-tiny-q5_1'))
    expect(c.installed()?.asr).toContain('ggml-tiny-q5_1.bin')
  })

  it('new graphics (or none any more) mean timing again', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.3 }, { key: speedKey(gpuPc), model: 'whisper-large-v3-turbo-q5_0', rtf: {}, at: 1 })
    const { c } = setup({ getHardware: async () => ({ ...gpuPc, gpu: { kind: 'none', name: '', vramGB: 0 } }), speed: s.deps })
    await c.start(); await c.idle()
    expect(s.timed).toEqual(['whisper-small-q5_1'])
    expect(s.stored()?.model).toBe('whisper-small-q5_1')
  })

  it("none keeps up: setup stops with the plain words, stores that, and says it again next time without timing; Try again times again", async () => {
    for (const os of ['win32', 'linux'] as const) {
      const pc = { ...cpuPc, os }
      const s = speed({ 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 1.1, 'whisper-tiny-q5_1': null })
      const first = setup({ getHardware: async () => pc, speed: s.deps })
      await first.c.start()
      expect(first.c.state).toMatchObject({ phase: 'error', message: tooSlow(os) })
      expect(first.c.installed()).toBeUndefined()
      expect(s.stored()).toMatchObject({ model: null, rtf: { 'whisper-small-q5_1': 2, 'whisper-base-q5_1': 1.1, 'whisper-tiny-q5_1': null } })
      expect(s.timed).toHaveLength(3)

      const again = setup({ getHardware: async () => pc, speed: s.deps, modelsDir: first.root })
      await again.c.start()
      expect(again.c.state).toMatchObject({ phase: 'error', message: tooSlow(os) })
      expect(s.timed).toHaveLength(3)
      expect(again.rec.asked).toEqual([])

      await again.c.retry()
      expect(s.timed).toHaveLength(6)
    }
  })

  it('a model that keeps failing its checksum is skipped for the next one', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.1, 'whisper-base-q5_1': 0.2 })
    const inner = fakeDownloadDeps({ stepMs: 0 })
    const hashFile = async (p: string) => (p.includes('small-q5_1') ? 'WRONG' : 'FAKE')
    const { c } = setup({ getHardware: async () => cpuPc, speed: s.deps, download: { ...inner, hashFile } })
    await c.start(); await c.idle()
    expect(c.state.phase).toBe('ready')
    expect(s.timed).toEqual(['whisper-base-q5_1'])
  })

  it('the quick core count still stops a 2-core computer without graphics before anything downloads or is timed', async () => {
    const s = speed({ 'whisper-small-q5_1': 0.1 })
    const { c, rec } = setup({ getHardware: async () => ({ ...cpuPc, cores: 2 }), speed: s.deps })
    await c.start()
    expect(c.state.phase).toBe('error')
    expect(rec.asked).toEqual([])
    expect(s.timed).toEqual([])
  })
})
