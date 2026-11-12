import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repo = path.dirname(site)
const deps = path.resolve(process.env.YOGURT_BUILD_DEPS || repo)
const require = createRequire(path.join(deps, 'app/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))
const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')))
const postcss = createRequire(fs.realpathSync(path.join(site, 'node_modules/next/package.json')))('postcss')
const outDir = path.join(site, 'public/marketing/app')
// Build the renderer from this repository at a reproducible commit.
const appCommit = execFileSync('git', ['rev-parse', process.env.YOGURT_APP_REF || 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yogurt-marketing-source-')))
process.on('exit', () => fs.rmSync(source, { recursive: true, force: true }))
const archive = execFileSync('git', ['archive', appCommit, 'app/src/renderer', 'app/src/shared'], { cwd: repo, maxBuffer: 32*1024*1024 })
execFileSync('tar', ['-xf', '-', '-C', source], { input: archive })
const sourceFiles = new Set()
await build({
  configFile: false, root: path.join(site, 'renderer'), publicDir: false, base: '/marketing/app/',
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: [{ find: '@app', replacement: path.join(source, 'app/src/renderer/src') }] },
  plugins: [
    { name: 'renderer-only', enforce: 'pre',
      async resolveId(id) {
        if (/^(electron|node:|@yogurt\/picker)/.test(id)) throw new Error(`Native import prohibited: ${id}`)
        if (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@app') && !id.startsWith('\0')) {
          return this.resolve(id, path.join(deps, 'app/marketing-entry.js'), { skipSelf: true })
        }
      },
      transform(code, id) {
        if (/\/app\/src\/(main|preload|engine)\//.test(id)) throw new Error(`Native source prohibited: ${id}`)
        if (id.startsWith(source + '/app/src/')) sourceFiles.add(path.relative(source, id))
        // Playback cannot exist in a marketing fixture; the real note/transcript/Ask remain unchanged.
        if (id.endsWith('/components/Player.tsx')) return 'export function Player() { return null }'
        if (id.endsWith('/components/FinishSetup.tsx')) return 'export function FinishSetup() { return null }'
        if (id.endsWith('/components/RecordingHint.tsx')) return 'export function RecordingHint() { return null }'
        // Shared platform helpers import this pure list from main; never bundle native permissions.
        if (id.endsWith('/shared/platform.ts')) {
          const permissions = execFileSync('git', ['show', `${appCommit}:app/src/main/permissions.ts`], { cwd: repo, encoding: 'utf8' })
          const kinds = permissions.match(/export const PERMISSION_KINDS: PermissionKind\[\] = (\[[^\n]+\])/)[1]
          return code.replace(/import \{ PERMISSION_KINDS \} from '\.\.\/main\/permissions'/, `const PERMISSION_KINDS: PermissionKind[] = ${kinds}`)
        }
        if (id.endsWith('/shared/i18n.ts')) return code.replace("'./locales/*.json'", "'./locales/en.json'")
        if (/\/renderer\/src\/(styles|workspace)\.css$/.test(id)) {
          // Force only this isolated frame to the renderer's own dark palette, even on a light OS.
          const dark = []
          const sheet = postcss.parse(code)
          sheet.walkAtRules('media', rule => {
            if (!/prefers-color-scheme:\s*dark/.test(rule.params)) return
            rule.walkRules(node => {
              const copy = node.clone()
              copy.selectors = copy.selectors.map(selector => selector.includes(':root') ? selector.replace(':root', ':root[data-marketing-theme="dark"]') : `:root[data-marketing-theme="dark"] ${selector}`)
              dark.push(copy.toString())
            })
            rule.remove()
          })
          code = sheet.toString()
          code += '\n' + dark.join('\n')
          return code.replace('@import "tailwindcss";', `@import "${require.resolve('tailwindcss/index.css')}" source(none);\n@source "${path.join(source, 'app/src/renderer/src')}";`)
        }
      },
    }, react(), tailwind(),
  ],
  build: { outDir, emptyOutDir: true, sourcemap: false, minify: true, license: { fileName: 'LICENSES.txt' },
    lib: { entry: path.join(site, 'renderer/entry.tsx'), name: 'YogurtMarketing', formats: ['iife'], fileName: () => 'renderer.js', cssFileName: 'renderer' },
  },
})
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
fs.writeFileSync(path.join(outDir, 'frame.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Fictional meeting · Yogurt</title><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="renderer.css"><script src="renderer.js" defer></script></head><body inert><div id="root"></div></body></html>\n`)
const files = Object.fromEntries(fs.readdirSync(outDir).map(name => {
  const bytes = fs.readFileSync(path.join(outDir, name))
  return [name, { bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: createHash('sha256').update(bytes).digest('hex') }]
}))
const manifest = { appCommit, generatedAt: new Date().toISOString(), source: 'app/src/renderer', fixture: 'site/renderer/bridge.mjs', nativeCode: false, stripped: ['Player', 'FinishSetup', 'RecordingHint', 'non-English locale tables'], sourceFiles: [...sourceFiles].sort(), files, totalGzipBytes: Object.entries(files).reduce((sum, [name, f]) => sum + (name.endsWith('.txt') ? 0 : f.gzipBytes), 0) }
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Renderer: ${(manifest.totalGzipBytes / 1024).toFixed(1)} KiB gzip. Stills must be regenerated with pnpm site:stills.`)
