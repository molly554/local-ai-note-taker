import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const helper = join(import.meta.dirname, '../resources/bin/yogurt-mac')

it.skipIf(process.platform !== 'darwin' || !existsSync(helper))('reading permissions returns without waiting for another app', () => {
  // No permission requests: this must work even when Music or Spotify does not answer Automation checks.
  const status = JSON.parse(execFileSync(helper, ['permissions'], { timeout: 5000, encoding: 'utf8' }))
  expect(status).toMatchObject({ mic: expect.any(String), systemAudio: expect.any(Number), calendar: expect.any(String), accessibility: expect.any(Boolean) })
}, 7000)
