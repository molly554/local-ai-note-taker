import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { WATCH_EVERY_MS, type Watch, type WatchLine } from './index'

/** Watches running now, so quitting can end them (they end by themselves when Yogurt's end of stdin closes) */
const running = new Set<ChildProcess>()
export const killAllWatches = () => { for (const c of running) c.kill('SIGKILL'); running.clear() }

/** yogurt-mac call-watch: one JSON line per reading of the call app, until its stdin is closed */
export const helperWatch = (binary: () => string): Watch => (ids, onLine) => {
  const child = spawn(binary(), ['call-watch', String(WATCH_EVERY_MS), ...ids], { stdio: ['pipe', 'pipe', 'pipe'] })
  running.add(child)
  // recording and transcription come first
  if (child.pid) { try { os.setPriority(child.pid, 10) } catch { /* it may have exited already */ } }
  createInterface({ input: child.stdout }).on('line', (l) => {
    try { onLine(JSON.parse(l) as WatchLine) } catch { /* a cut line: the next reading comes soon */ }
  })
  child.stderr.on('data', () => {})
  child.on('error', (e) => console.error('call names: yogurt-mac call-watch failed', e))
  child.on('exit', () => running.delete(child))
  return {
    stop() {
      child.stdin.end()
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000).unref()
    },
  }
}
