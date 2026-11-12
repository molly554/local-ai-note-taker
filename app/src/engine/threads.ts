/**
 * Threads for the notes model's contexts. Without graphics node-llama-cpp asks for at least 4, and llama.cpp's threads
 * wait by spinning: on a 2-core computer that took 40 s a word on Windows (whisper's VAD had the same trouble).
 * Off a Mac: the processor's math cores, never more than it has. A Mac keeps what it always had (undefined).
 */
export function engineThreads(platform: string, mathCores: number, logical: number): number | undefined {
  if (platform === 'darwin') return undefined
  return Math.max(1, Math.min(mathCores || logical, logical))
}
