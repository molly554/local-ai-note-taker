import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

if (existsSync(join(homedir(), '.yogurt-no-local-e2e'))) {
  throw new Error('Yogurt E2E is disabled on this Mac by ~/.yogurt-no-local-e2e. Run typecheck, Vitest and lint locally; push and read E2E results on CI. Do not launch Electron under Playwright here.')
}

// Yogurt runs hidden during tests so it never pops up or takes focus; YOGURT_BACKGROUND=0 to watch
process.env.YOGURT_BACKGROUND ??= '1'
// tests read the English text, whatever this computer's language
process.env.YOGURT_SYSTEM_LANGUAGES ??= 'en-US'

// CI machines are slower: a test that only passes on its second try is reported as flaky, not hidden
export default defineConfig({
  testDir: 'e2e', timeout: 60_000, retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['dot']] : 'list',
  testIgnore: process.env.CI ? ['**/zz-*.spec.ts', '**/zz-fixtures/**'] : [],
})
