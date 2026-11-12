// The packaged app holds only the built code: a source folder inside app.asar means the build settings weren't applied.
// node scripts/asar-check.mjs "dist/mac-arm64/Lynote NoteTaker.app/Contents/Resources/app.asar" (exits 1 and names them)
import asar from '@electron/asar'
import { fileURLToPath } from 'node:url'

const SOURCE = /^\/(src|e2e|test|dist|native|scripts|docs)(\/|$)/
// the workspace's own packages are bundled by vite; a copy in node_modules is their TypeScript source
const WORKSPACE = /^\/node_modules\/@yogurt(\/|$)/

/** source folders among the archive's paths (top level, and workspace packages), each once */
export const sourceFolders = (paths) => [...new Set(paths.flatMap((p) => (SOURCE.test(p) ? [p.split('/').slice(0, 2).join('/')] : WORKSPACE.test(p) ? ['/node_modules/@yogurt'] : [])))]

// Windows lists the archive with backslashes
export const checkAsar = (file) => sourceFolders(asar.listPackage(file, {}).map((p) => p.replaceAll('\\', '/')))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = checkAsar(process.argv[2])
  if (bad.length) { console.error(`app.asar has source folders in it (${bad.join(', ')}); stopping`); process.exit(1) }
  console.log('app.asar holds only the built app')
}
