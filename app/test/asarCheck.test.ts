import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackage } from '@electron/asar'
// @ts-expect-error plain script, no types
import { sourceFolders, checkAsar } from '../scripts/asar-check.mjs'

it('flags source and test folders at the top of the archive, nothing else', () => {
  expect(sourceFolders(['/out', '/out/main/index.js', '/package.json', '/node_modules/node-llama-cpp/src/index.js'])).toEqual([])
  expect(sourceFolders(['/out/main/index.js', '/src', '/src/main/index.ts', '/e2e/a.spec.ts', '/test/x.test.ts', '/dist/x', '/native/a.swift'])).toEqual(['/src', '/e2e', '/test', '/dist', '/native'])
})

it('flags workspace packages copied into node_modules (vite bundles them; a copy is their source)', () => {
  expect(sourceFolders(['/node_modules/@yogurt/picker/src/index.ts', '/node_modules/@yogurt/picker/package.json', '/node_modules/electron-updater/out/main.js'])).toEqual(['/node_modules/@yogurt'])
})

it('reads a real archive: a clean one passes, one with src in it fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-asar-'))
  const make = async (name: string, files: string[]) => {
    const dir = join(root, name)
    for (const f of files) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), 'x') }
    await createPackage(dir, join(root, `${name}.asar`))
    return join(root, `${name}.asar`)
  }
  expect(checkAsar(await make('clean', ['out/main/index.js', 'package.json']))).toEqual([])
  expect(checkAsar(await make('dirty', ['out/main/index.js', 'src/main/index.ts']))).toEqual(['/src'])
})
