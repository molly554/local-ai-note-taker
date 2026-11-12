import { defineConfig } from 'vitest/config'
// GitHub's Windows runners open and write SQLite many times slower than a Mac: tests that take a second here pass 5 s there
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: process.platform === 'win32' ? 30_000 : 5_000 } })
