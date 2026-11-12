import { asrCandidates, pick, pickAsr, pickBySpeed, speedKey, type Catalog, type CatalogAsr, type Choice, type Hardware } from '@yogurt/picker'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ChecksumError, DiskSpaceError, ensureFile, fileNameFor, isVerified, partialDownloadGB, type DownloadDeps } from './downloader'
import type { SetupState } from '../shared/types'
import { t } from '../shared/i18n'
import { tooSlow, tooWeak } from './localCheck'

/** What the speed check found on one computer (speedKey): the model kept (null: none keeps up) and each one's time over the clip's length */
export type SpeedResult = { key: string; model: string | null; rtf: Record<string, number | null>; at: number; /** whisper had to leave the graphics card while it was timed */ gpuOff?: boolean }
/** Windows and Linux: time a speech model on this computer (null: it ran out of time), and keep what was found */
export type SpeedDeps = {
  measure(modelPath: string): Promise<{ rtf: number | null; gpuOff?: boolean }>
  load(): SpeedResult | undefined
  save(r: SpeedResult): void
}

export type SetupDeps = {
  getHardware(): Promise<Hardware>
  /** the catalog in this build; never waits on the network */
  getCatalog(): Promise<Catalog>
  /** speech and notes models live in folders inside this one */
  modelsDir: string
  download: DownloadDeps
  /** fake mode only: treat every file as having this hash */
  sha256Override?: string
  /** waits between download retries; one retry per entry */
  retryDelaysMs?: number[]
  /** the first notes model downloads after ready: the waits between tries when it fails (the last one repeats) */
  notesRetryMs?: number[]
  /** Windows and Linux: the speed check picks the speech model (a Mac never has it: turbo, as always) */
  speed?: SpeedDeps
}

/** Where the models ended up, for the parts of the app that use them; llm once the first notes model is in (after ready) */
export type Installed = { asr: string; llm?: string; recommendedLlm?: string; /** meaning search across meetings; word search works without it */ embed?: string }

/** the first notes model keeps being tried after ready: a minute, five, then every ten (a download picks up where it stopped) */
const NOTES_RETRY_MS = [60_000, 5 * 60_000, 10 * 60_000]

const DISK_HEADROOM_GB = 10

/** Plain-English message for anything that can go wrong during setup. */
export function friendly(err: unknown): string {
  if (err instanceof DiskSpaceError) return t('Not enough disk space. Free up {gb} GB and try again.', { gb: err.needGB })
  if (err instanceof ChecksumError) return t('The download was corrupted. Try again.')
  const msg = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|socket|HTTP \d|receiving data/i.test(msg)) {
    return t('Download interrupted. Check your connection and try again.')
  }
  return t("Setup didn't finish. Try again.")
}

/** One file to fetch: where it goes inside the models folder, and how big it is (for the progress bar) */
type Item = { url: string; sha256: string; bytes: number; dir: string; fileName: string }

const llmItem = (dir: string, c: Choice): Item => ({ url: c.build.url, sha256: c.build.sha256, bytes: c.build.sizeGB * 1e9, dir, fileName: fileNameFor(c.build.url) })

export class SetupController {
  private _state: SetupState = { phase: 'checking', fraction: 0 }
  private listeners = new Set<(s: SetupState) => void>()
  private busy = false
  private background: Promise<void> | undefined
  private backgroundItem: Item | undefined
  private backgroundFailed = false
  private retryNotes: (() => void) | undefined
  private paths: Installed | undefined
  private notesListeners = new Set<() => void>()
  private embedListeners = new Set<() => void>()
  /** the embedding model's download, while it keeps being tried after a failure */
  private embedding: Promise<void> | undefined
  /** Try again after an error: time the speech models again instead of trusting what was stored */
  private recheck = false

  constructor(private deps: SetupDeps) {}

  get state() { return this._state }
  onState(cb: (s: SetupState) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private set(s: SetupState) {
    // the bar only moves forward, and only speaks up when a whole percent changes
    const prev = this._state
    if (s.phase === prev.phase && s.phase === 'downloading') {
      s = { ...s, fraction: Math.max(s.fraction, prev.fraction) }
      if (Math.floor(s.fraction * 100) === Math.floor(prev.fraction * 100)) { this._state = s; return }
    }
    this._state = s
    for (const l of this.listeners) l(s)
  }

  /** Where the models are, once setup is ready. The notes models show up when their downloads finish. */
  installed(): Installed | undefined { return this.paths }

  /** called once the first notes model is on the Mac (at ready when it already was) */
  onNotesModel(cb: () => void) { this.notesListeners.add(cb); return () => this.notesListeners.delete(cb) }

  /** called once the embedding model is on the Mac (at ready when it already was) */
  onEmbedModel(cb: () => void) { this.embedListeners.add(cb); return () => this.embedListeners.delete(cb) }

  /** Resolves when the notes and embedding models have finished downloading (or the bigger one gave up). Ready never waits for them. */
  async idle(): Promise<void> {
    await this.background
    await this.embedding
  }

  async start() {
    if (this.busy) return
    this.busy = true
    try { await this.run() } finally { this.busy = false }
  }

  /** Retry setup, wake the existing first-model wait, or retry the failed bigger model. */
  async retry() {
    if (this._state.phase === 'error') { this.recheck = true; return this.start() }
    if (this.retryNotes) { this.retryNotes(); return }
    if (this._state.phase === 'ready' && this.backgroundFailed && this.backgroundItem) this.startBackground(this.backgroundItem)
  }

  private async run() {
    this.set({ phase: 'checking', fraction: 0 })
    try {
      const [hw, catalog] = await Promise.all([this.deps.getHardware(), this.deps.getCatalog()])
      const llm = pick(hw, catalog.models)
      const weak = tooWeak(hw, !!llm.recommended)
      if (!llm.recommended || weak) return this.set({ phase: 'error', fraction: 0, message: weak ?? '' })

      // The first notes model is the starter when it downloads faster than the pick; otherwise the pick itself.
      const starter = llm.starter && llm.starter.build.sizeGB < llm.recommended.build.sizeGB ? llm.starter : llm.recommended
      const later = starter === llm.recommended ? undefined : llm.recommended
      console.info('NOTES', `notes models for this computer: ${starter.model.id}${later ? `, then ${later.model.id}` : ''} (graphics ${hw.gpu.kind}${hw.gpu.name ? ` ${hw.gpu.name}` : ''}, ${hw.totalRamGB} GB)`)
      const dirs = { asr: join(this.deps.modelsDir, 'asr'), llm: join(this.deps.modelsDir, 'llm'), embed: join(this.deps.modelsDir, 'embed') }

      // Speech first: ready (recording works) once it is in. The notes models come after.
      let asr = pickAsr(hw, catalog)
      const asrItem = (m: CatalogAsr): Item => ({ url: m.url, sha256: m.sha256, bytes: m.bytes, dir: dirs.asr, fileName: fileNameFor(m.url) })
      // whisper-server is built into the app (catalog.whisperServer.bundled), so only the speech model is downloaded for it.
      const starterItem = llmItem(dirs.llm, starter)
      const e = catalog.embedding
      const embedItem: Item = { url: e.url, sha256: e.sha256, bytes: e.bytes, dir: dirs.embed, fileName: fileNameFor(e.url) }

      // Windows and Linux: the speed check's stored pick for this computer, or the models it will time, best first
      const speed = hw.os === 'darwin' ? undefined : this.deps.speed
      const key = speedKey(hw)
      const saved = speed && !this.recheck ? speed.load() : undefined
      this.recheck = false
      const known = saved?.key === key ? saved : undefined
      const candidates = speed ? asrCandidates(hw, catalog) : []
      if (speed && (known?.model === null || !candidates.length)) return this.set({ phase: 'error', fraction: 0, message: tooSlow(hw.os) })
      const keep = known && candidates.find((a) => a.id === known.model)

      const waitFor: Item[] = [asrItem(speed ? keep ?? candidates[0] : asr.model)]
      const total = waitFor.reduce((n, i) => n + i.bytes, 0)
      // room for the first notes model too, so it never runs out of disk after ready
      await this.checkDisk([...waitFor, starterItem, embedItem])

      let done = 0
      const report = (item: Item, fraction: number) => this.set({ phase: 'downloading', fraction: Math.min(1, (done + item.bytes * fraction) / total) })
      const get = async (item: Item) => {
        // already on disk: no progress to show, so a finished install goes straight to ready
        if (!isVerified(item.dir, item.fileName, this.sha(item))) report(item, 0)
        const path = await this.fetch(item, (p) => report(item, p.fraction))
        done += item.bytes
        return path
      }

      // speech: if the first choice downloads corrupted twice, the smaller one takes its place
      const tried: string[] = []
      let asrPath: string | undefined
      if (speed && keep) asrPath = await get(asrItem(keep))
      else if (speed) {
        const r = await this.timeSpeech(speed, candidates, get, asrItem)
        speed.save({ key, ...r.result, at: Date.now() })
        if (!r.path) return this.set({ phase: 'error', fraction: this._state.fraction, message: tooSlow(hw.os) })
        asrPath = r.path
      }
      while (!asrPath) {
        try { asrPath = await get(asrItem(asr.model)) } catch (err) {
          if (!(err instanceof ChecksumError) || !asr.fallback) throw err
          tried.push(asr.model.id)
          asr = pickAsr(hw, catalog, { exclude: tried })
        }
      }
      this.paths = { asr: asrPath }
      this.set({ phase: 'ready', fraction: 1 })
      this.startNotes(starterItem, embedItem, later && llmItem(dirs.llm, later))
    } catch (err) {
      console.error('setup failed', err)
      this.set({ phase: 'error', fraction: this._state.fraction, message: friendly(err) })
    }
  }

  /**
   * Windows and Linux: download each speech model in turn and time it on a short clip, until one reads two voices as fast
   * as they talk. The ones that were too slow are deleted again. A model that downloads corrupted is skipped.
   */
  private async timeSpeech(speed: SpeedDeps, candidates: CatalogAsr[], get: (i: Item) => Promise<string>, asrItem: (m: CatalogAsr) => Item) {
    const paths = new Map<string, string>()
    let gpuOff = false
    const r = await pickBySpeed(candidates, async (m) => {
      try { paths.set(m.id, await get(asrItem(m))) } catch (err) {
        if (err instanceof ChecksumError) { console.warn(`speed check: ${m.id} downloaded corrupted, trying the next one`); return null }
        throw err
      }
      // "Preparing the transcription model" while it is timed
      this.set({ phase: 'downloading', fraction: 1 })
      const t = await speed.measure(paths.get(m.id)!)
      if (t.gpuOff) gpuOff = true
      console.log(`speed check: ${m.id} took ${t.rtf === null ? 'too long' : `${t.rtf.toFixed(2)} x`} the clip's length`)
      return t.rtf
    })
    for (const [id, p] of paths) if (id !== r.model?.id) rmSync(p, { force: true })
    return { path: r.model && paths.get(r.model.id), result: { model: r.model?.id ?? null, rtf: r.rtf, ...(gpuOff ? { gpuOff } : {}) } }
  }

  /**
   * The first notes model downloads while Yogurt already records: it is tried until it lands (meetings recorded
   * meanwhile get their notes then). The bigger one follows.
   */
  private startNotes(first: Item, embed: Item, later: Item | undefined) {
    this.background = (async () => {
      const waits = this.deps.notesRetryMs ?? NOTES_RETRY_MS
      // Waiting notes show whole percents; every 10% goes in the log.
      let shown = -1, logged = -1
      const progress = (p: { fraction: number; etaSec: number }) => {
        const pct = Math.floor(p.fraction * 100)
        if (Math.floor(pct / 10) > logged) { logged = Math.floor(pct / 10); console.info('NOTES', `notes model download ${pct}%`) }
        if (pct !== shown) { shown = pct; this.set({ ...this._state, notesFraction: p.fraction, notesEtaSec: p.etaSec > 0 && Number.isFinite(p.etaSec) ? p.etaSec : undefined }) }
      }
      const already = isVerified(first.dir, first.fileName, this.sha(first))
      if (!already) console.info('NOTES', `downloading the notes model ${first.fileName}`)
      for (let i = 0; ; i++) {
        shown = -1
        this.set({ ...this._state, notesError: undefined, ...(already ? {} : { notesDownloading: true, notesFraction: 0, notesTotalBytes: first.bytes, notesEtaSec: undefined }) })
        try {
          const path = await this.fetch(first, already ? undefined : progress)
          if (this.paths) this.paths = { ...this.paths, llm: path }
          if (!already) console.info('NOTES', 'the notes model is in')
          if (this._state.notesFraction !== undefined || this._state.notesDownloading) this.set({ ...this._state, notesFraction: undefined, notesDownloading: undefined, notesTotalBytes: undefined, notesEtaSec: undefined })
          break
        } catch (err) {
          console.warn('the notes model did not download yet, trying again', err)
          await new Promise<void>((resolve) => {
            const wake = () => { clearTimeout(timer); this.retryNotes = undefined; resolve() }
            const timer = setTimeout(wake, waits[Math.min(i, waits.length - 1)])
            this.retryNotes = wake
            this.set({ ...this._state, notesError: friendly(err), notesFraction: undefined, notesDownloading: undefined, notesTotalBytes: undefined, notesEtaSec: undefined })
          })
        }
      }
      for (const l of this.notesListeners) { try { l() } catch (e) { console.error('notes model listener failed', e) } }
    })()
    this.background = this.background.then(() => this.startEmbedding(embed))
    if (later) this.background = this.background.then(() => this.startBackground(later))
  }

  /**
   * The embedding model (meaning search across meetings), small, after the first notes model. One try first, so the
   * bigger notes model never waits on it; failing, it keeps being tried meanwhile. Chat works on words until it lands.
   */
  private async startEmbedding(item: Item) {
    const landed = (path: string) => {
      if (this.paths) this.paths = { ...this.paths, embed: path }
      for (const l of this.embedListeners) { try { l() } catch (e) { console.error('embedding model listener failed', e) } }
    }
    try { landed(await this.fetch(item)); return } catch (err) { console.warn('the embedding model did not download yet, trying again', err) }
    const waits = this.deps.notesRetryMs ?? NOTES_RETRY_MS
    this.embedding = (async () => {
      for (let i = 0; ; i++) {
        await new Promise((r) => setTimeout(r, waits[Math.min(i, waits.length - 1)]))
        try { landed(await this.fetch(item)); return } catch (err) { console.warn('the embedding model did not download yet, trying again', err) }
      }
    })()
  }

  /** The bigger notes model downloads while Yogurt is already usable. Failing here is not an error screen. */
  private startBackground(item: Item): Promise<void> {
    this.backgroundItem = item
    this.backgroundFailed = false
    this.background = this.fetch(item).then((path) => { if (this.paths) this.paths = { ...this.paths, recommendedLlm: path } }).catch((err) => {
      this.backgroundFailed = true
      console.warn('the bigger notes model did not download', err)
    })
    return this.background
  }

  private async checkDisk(items: Item[]) {
    const missing = items.filter((i) => !isVerified(i.dir, i.fileName, this.sha(i)))
    if (!missing.length) return
    const need = missing.reduce((n, i) => n + i.bytes / 1e9 - partialDownloadGB(i.dir, i.fileName), 0) + DISK_HEADROOM_GB - (await this.deps.download.freeDiskGB(this.deps.modelsDir))
    if (need > 0) throw new DiskSpaceError(Math.ceil(need))
  }

  private sha(i: Item) { return this.deps.sha256Override ?? i.sha256 }

  /** Download (or reuse) a verified file, retrying transient failures. */
  private async fetch(i: Item, onProgress?: (p: { fraction: number; etaSec: number }) => void): Promise<string> {
    const delays = this.deps.retryDelaysMs ?? [2000, 8000]
    for (let attempt = 0; ; attempt++) {
      try {
        return await ensureFile({ url: i.url, sha256: this.sha(i), sizeGB: i.bytes / 1e9, dir: i.dir, fileName: i.fileName, onProgress }, this.deps.download)
      } catch (err) {
        if (err instanceof DiskSpaceError || err instanceof ChecksumError || attempt >= delays.length) throw err
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
  }
}

