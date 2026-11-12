// Opens the built app in demo mode (pnpm -C app demo): a stand-in transcriber, notes model and call audio, so it
// runs in seconds with nothing downloaded, and a profile folder of its own, so real meetings are never touched.
// The same on Windows, Linux and a Mac: no shell syntax for setting the switches.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.YOGURT_USER_DATA ?? join(tmpdir(), 'lynote-notetaker-demo')
console.log(`Demo mode. Its meetings are kept in ${profile}`)
const child = spawn(electron, [join(app, 'out/main/index.js')], { stdio: 'inherit', env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile } })
child.on('exit', (code) => process.exit(code ?? 0))
