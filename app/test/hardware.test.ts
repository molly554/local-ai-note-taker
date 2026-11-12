import { describe, expect, it } from 'vitest'
import { toHardware } from '../src/main/hardware'

const sys = { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', totalRamBytes: 8_589_934_592, freeDiskGB: 123.456 }

describe('toHardware', () => {
  it('an Apple Silicon Mac shares memory with its graphics', () => {
    const hw = toHardware(sys)
    expect(hw).toMatchObject({ os: 'darwin', arch: 'arm64', cpuModel: 'Apple M2', gpu: { kind: 'unified', name: 'Apple M2' } })
  })
  it('an 8 GB Mac reports 8.6 GB (bytes / 1e9), a 6 GB one stays under 8', () => {
    expect(toHardware(sys).totalRamGB).toBe(8.6)
    expect(toHardware({ ...sys, totalRamBytes: 6e9 }).totalRamGB).toBe(6)
  })
  it('rounds free disk to one decimal', () => {
    expect(toHardware(sys).freeDiskGB).toBe(123.5)
  })
})

describe('graphics on Windows and Linux (the notes engine checks the card)', () => {
  const pc = { platform: 'win32', arch: 'x64', cpuModel: 'Intel Core i7-12700H', totalRamBytes: 32e9, freeDiskGB: 200 }
  it('a graphics card with its own memory', () => {
    expect(toHardware(pc, { gpuType: 'cuda', vramTotalGB: 8.04, unifiedGB: 0, gpuNames: ['NVIDIA GeForce RTX 4060 Laptop GPU'] }).gpu)
      .toEqual({ kind: 'discrete', name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vramGB: 8 })
  })
  it('graphics that share the memory', () => {
    expect(toHardware(pc, { gpuType: 'vulkan', vramTotalGB: 16, unifiedGB: 16, gpuNames: ['Intel(R) Iris(R) Xe Graphics'] }).gpu.kind).toBe('unified')
  })
  it('no usable graphics, or a check that failed: the processor only', () => {
    expect(toHardware(pc, { gpuType: false, vramTotalGB: 0, unifiedGB: 0, gpuNames: [] }).gpu).toEqual({ kind: 'none', name: '', vramGB: 0 })
    expect(toHardware(pc, null).gpu.kind).toBe('none')
  })
  it('a Mac never asks', () => {
    expect(toHardware(sys, { gpuType: false, vramTotalGB: 0, unifiedGB: 0, gpuNames: [] }).gpu).toEqual({ kind: 'unified', name: 'Apple M2', vramGB: 0 })
  })
})

describe('processor cores', () => {
  it('Windows and Linux count them (whisper on the processor needs enough); a Mac is left as it was', () => {
    expect(toHardware({ ...sys, platform: 'linux', cores: 6 }, null).cores).toBe(6)
    expect(toHardware({ ...sys, cores: 8 }).cores).toBeUndefined()
  })
})
