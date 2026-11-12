import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // yauzl, yazl and zod are bundled in, so their licences go next to the bundle
      license: { fileName: 'LICENSES.txt' },
      externalizeDeps: { exclude: ['@yogurt/picker'] },
      rollupOptions: { input: { index: resolve('src/main/index.ts'), engine: resolve('src/engine/worker.ts') } },
    },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') }, output: { format: 'cjs' } } },
  },
  renderer: {
    root: 'src/renderer',
    build: { license: { fileName: 'LICENSES.txt' }, rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [
      react(),
      tailwindcss(),
      {
        // Strict CSP for shipped builds; dev needs inline scripts for hot reload.
        name: 'yogurt-csp',
        apply: 'build',
        transformIndexHtml: (html: string) =>
          html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob: yogurt-audio:" />`),
      },
    ],
  },
})
