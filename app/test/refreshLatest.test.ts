import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain script, no types
import { refreshLatest } from '../scripts/refresh-latest.mjs'

const sha = (b: Buffer) => createHash('sha512').update(b).digest('base64')

it('after stapling changed the disk image, latest-mac.yml gets its new checksum and size again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-latest-'))
  writeFileSync(join(dir, 'Yogurt-mac-arm64.zip'), 'zip')
  writeFileSync(join(dir, 'Yogurt-mac-arm64.dmg'), 'dmg, stapled')
  const yml = join(dir, 'latest-mac.yml')
  writeFileSync(yml, `version: 0.1.0
files:
  - url: Yogurt-mac-arm64.zip
    sha512: OLDZIP==
    size: 1
  - url: Yogurt-mac-arm64.dmg
    sha512: OLDDMG==
    size: 2
path: Yogurt-mac-arm64.zip
sha512: OLDZIP==
releaseDate: '2026-10-30T14:52:46.993Z'
`)
  refreshLatest(yml)
  expect(readFileSync(yml, 'utf8')).toBe(`version: 0.1.0
files:
  - url: Yogurt-mac-arm64.zip
    sha512: ${sha(Buffer.from('zip'))}
    size: 3
  - url: Yogurt-mac-arm64.dmg
    sha512: ${sha(Buffer.from('dmg, stapled'))}
    size: 12
path: Yogurt-mac-arm64.zip
sha512: ${sha(Buffer.from('zip'))}
releaseDate: '2026-10-30T14:52:46.993Z'
`)
})
