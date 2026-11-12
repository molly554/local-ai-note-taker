import { expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelperRunner } from '../src/main/calendar'

/** a stand-in helper: answers at once, or waits (like a permission question nobody answered) */
function fakeHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-helper-'))
  const file = join(dir, 'yogurt-mac')
  writeFileSync(file, '#!/bin/sh\nif [ "$1" = wait ]; then exec sleep 60; fi\necho \'{"ok":true}\'\n')
  chmodSync(file, 0o755)
  return file
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// the stand-in helper is a shell script, which Windows can't start
it.skipIf(process.platform === 'win32')('answers with the helper\'s JSON', async () => {
  const r = createHelperRunner(fakeHelper)
  await expect(r.run(['status'])).resolves.toEqual({ ok: true })
  expect(r.running()).toEqual([])
})

it.skipIf(process.platform === 'win32')('quitting kills a helper still waiting, so none outlives Yogurt', async () => {
  const r = createHelperRunner(fakeHelper)
  const waiting = r.run(['wait'])
  await new Promise((res) => setTimeout(res, 200))
  const [pid] = r.running()
  expect(alive(pid)).toBe(true)
  r.killAll()
  await expect(waiting).rejects.toThrow()
  expect(alive(pid)).toBe(false)
  expect(r.running()).toEqual([])
})
