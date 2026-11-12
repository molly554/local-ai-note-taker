// Stapling the notarization ticket onto the disk image changes the file after electron-builder wrote latest-mac.yml:
// this writes each file's sha512 and size again, so installed copies can check what they download.
// node scripts/refresh-latest.mjs dist/latest-mac.yml
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function refreshLatest(yml) {
  const dir = dirname(yml)
  const sha = (name) => createHash('sha512').update(readFileSync(join(dir, name))).digest('base64')
  const lines = readFileSync(yml, 'utf8').split('\n')
  let file = null
  const out = lines.map((line) => {
    const url = /^\s*- url: (.+)$/.exec(line) ?? /^path: (.+)$/.exec(line)
    if (url) { file = url[1].trim(); return line }
    const hash = /^(\s*)sha512: /.exec(line)
    if (hash && file) return `${hash[1]}sha512: ${sha(file)}`
    const size = /^(\s*)size: /.exec(line)
    if (size && file) return `${size[1]}size: ${statSync(join(dir, file)).size}`
    return line
  })
  writeFileSync(yml, out.join('\n'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) refreshLatest(process.argv[2])
