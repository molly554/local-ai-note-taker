import type { AsrChoice, Catalog, CatalogAsr, Hardware } from './types'

/**
 * The speech model for this Mac: the best one whose memory need fits (turbo on every Mac with 8 GB or more,
 * because the notes model never runs while recording on small Macs), small under that or when turbo failed
 * verification. The catalog lists them best first. Last-resort models are for the Windows and Linux speed check only.
 */
export function pickAsr(hw: Hardware, c: Catalog, opts: { exclude?: string[] } = {}): AsrChoice {
  const all = c.asr.filter((a) => !a.lastResort)
  const usable = all.filter((a) => !opts.exclude?.includes(a.id))
  const list = usable.length ? usable : all
  // Windows and Linux without graphics: whisper runs on the processor, where only the small model keeps up (a Mac always has them)
  const cpuOnly = hw.os !== 'darwin' && hw.gpu.kind === 'none'
  const fits = list.filter((a) => a.minMemGB <= hw.totalRamGB).sort((a, b) => (cpuOnly ? a.minMemGB - b.minMemGB : 0))
  const model = fits[0] ?? [...list].sort((a, b) => a.minMemGB - b.minMemGB)[0]
  const fallback = list.find((a) => a !== model && a.minMemGB <= model.minMemGB)
  return { model, ...(fallback ? { fallback } : {}) }
}

/**
 * One meeting is two tracks (the mic and the computer's sound) read live, so a model keeps up only if its careful
 * (final) reading of a clip takes at most half the clip's length.
 */
export const KEEPS_UP_RTF = 0.5

/**
 * Windows and Linux: the speech models the speed check tries, best first (a Mac has none: it never measures). On the
 * processor alone turbo is left out: measured on 2 cores it took 4 to 9 times the clip's length.
 */
export function asrCandidates(hw: Hardware, c: Catalog, opts: { exclude?: string[] } = {}): CatalogAsr[] {
  if (hw.os === 'darwin') return []
  const cpuOnly = hw.gpu.kind === 'none'
  return c.asr.filter((a) => a.minMemGB <= hw.totalRamGB && !(cpuOnly && a.gpuOnly) && !opts.exclude?.includes(a.id))
}

/**
 * Times the candidates in order and keeps the first that keeps up; nothing smaller is timed after it.
 * measure gives the realtime factor (time taken over the clip's length), or null when it ran out of time.
 */
export async function pickBySpeed<M extends { id: string }>(candidates: M[], measure: (m: M) => Promise<number | null>): Promise<{ model: M | null; rtf: Record<string, number | null> }> {
  const rtf: Record<string, number | null> = {}
  for (const m of candidates) {
    const r = await measure(m)
    rtf[m.id] = r
    if (r !== null && r <= KEEPS_UP_RTF) return { model: m, rtf }
  }
  return { model: null, rtf }
}

/** What the speed depends on: the processor and the graphics. A different one of either and the check runs again. */
export const speedKey = (hw: Hardware): string => [hw.os, hw.arch, hw.cpuModel, hw.cores ?? '', hw.gpu.kind, hw.gpu.name].join('|')
