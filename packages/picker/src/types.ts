export type OS = 'darwin' | 'win32' | 'linux'

export interface Hardware {
  os: OS
  arch: string
  cpuModel: string
  totalRamGB: number
  freeDiskGB: number
  gpu: { kind: 'unified' | 'discrete' | 'none'; name: string; vramGB: number }
  /** processor cores (Windows and Linux; a Mac leaves it out) */
  cores?: number
}

export interface CatalogBuild {
  quant: string
  url: string
  sha256: string
  sizeGB: number
  paramsB: number
  activeParamsB: number
}

export interface CatalogModel {
  id: string
  name: string
  family: string
  license: string
  agentScore: number
  chatScore: number
  contextMax: number
  minAppVersion: string
  addedAt: string
  starter: boolean
  /** offered only when no other model runs well here (a tiny model for weak computers) */
  lastResort?: boolean
  /** a squeezed build of this other model: offered only where that one doesn't run well */
  squeezedOf?: string
  /** one-line trade-off shown in the model list, e.g. "Very fast, less capable" */
  description?: string
  builds: CatalogBuild[]
}

/** A speech model (whisper.cpp ggml file) */
export interface CatalogAsr {
  id: string
  name: string
  license: string
  url: string
  sha256: string
  sizeGB: number
  bytes: number
  /** least memory (GB) the Mac needs for this one; the list is ordered best first */
  minMemGB: number
  /** never on the processor alone: too slow to keep up there (turbo) */
  gpuOnly?: boolean
  /** Windows and Linux only, picked by the speed check when nothing better keeps up; never on a Mac */
  lastResort?: boolean
}

/** The embedding model for meaning search across meetings: one GGUF file, run by the notes model's worker */
export interface CatalogEmbedding {
  id: string
  name: string
  license: string
  url: string
  sha256: string
  bytes: number
  /** the vector length kept (EmbeddingGemma's first dims are a smaller embedding of their own) */
  dims: number
}

/** One file of a downloaded model folder; path is relative to it */
export interface CatalogFile {
  path: string
  url: string
  sha256: string
  bytes: number
}

/** The whisper-server program Yogurt builds itself */
export interface CatalogBinary {
  id: string
  tag: string
  url?: string
  sha256?: string
  bytes?: number
  /** not built yet: setup skips it */
  pending?: boolean
  /** built into the app (scripts/native.sh), nothing to download */
  bundled?: boolean
  note?: string
}

export interface Catalog {
  version: 1
  models: CatalogModel[]
  whisperCpp: { tag: string; commit: string }
  asr: CatalogAsr[]
  whisperServer: CatalogBinary
  embedding: CatalogEmbedding
}

export interface AsrChoice {
  model: CatalogAsr
  /** used if the first one's download fails verification */
  fallback?: CatalogAsr
}

export interface Choice {
  model: CatalogModel
  build: CatalogBuild
  contextSize: number
  estTokPerSec: number
  /** split: what fits on the graphics card runs there, the rest from system memory */
  device: 'gpu' | 'cpu' | 'split'
  /** 0 when there is enough free disk; otherwise GB the user must free */
  needsDiskGB: number
}

export interface PickResult {
  recommended: Choice | null
  faster?: Choice
  smarter?: Choice
  /** fast-enough choices, ranked best first */
  all: Choice[]
  /** catalog models this computer can't run well: too big ('memory') or too slow ('slow') */
  unavailable: { model: CatalogModel; reason: 'memory' | 'slow' }[]
  starter: Choice | null
  liteMode: boolean
}
