import os from 'node:os'
import type { Hardware, OS } from '@yogurt/picker'
import { realDeps } from './downloader'

export type SysInfo = { platform: string; arch: string; cpuModel: string; totalRamBytes: number; freeDiskGB: number; cores?: number }

/** What the notes engine found (node-llama-cpp): the graphics it can use, their memory, their names. gpuType false: none */
export type GpuProbe = { gpuType: string | false; vramTotalGB: number; unifiedGB: number; gpuNames: string[] }

/**
 * A Mac (Apple Silicon) shares memory with its graphics: no probe needed, as always. Windows and Linux ask the notes
 * engine what it can use: a card with its own memory, graphics sharing the memory, or none (also when the
 * check failed or crashed: then the processor alone).
 */
export function toHardware(sys: SysInfo, probe?: GpuProbe | null): Hardware {
  const mac = sys.platform === 'darwin'
  const kind = mac ? 'unified' : !probe?.gpuType ? 'none' : probe.unifiedGB > 0 ? 'unified' : 'discrete'
  return {
    os: sys.platform as OS,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    totalRamGB: Math.round((sys.totalRamBytes / 1e9) * 10) / 10,
    freeDiskGB: Math.round(sys.freeDiskGB * 10) / 10,
    gpu: mac ? { kind, name: sys.cpuModel, vramGB: 0 }
      : { kind, name: kind === 'none' ? '' : probe?.gpuNames[0] ?? '', vramGB: kind === 'none' ? 0 : Math.round((probe?.vramTotalGB ?? 0) * 10) / 10 },
    ...(!mac && sys.cores ? { cores: sys.cores } : {}),
  }
}

export async function readSysInfo(diskDir: string): Promise<SysInfo> {
  return {
    platform: process.platform, arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cores: os.availableParallelism(),
    totalRamBytes: os.totalmem(),
    freeDiskGB: await realDeps.freeDiskGB(diskDir),
  }
}
