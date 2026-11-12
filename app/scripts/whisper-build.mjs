#!/usr/bin/env node
// Builds whisper-server for Windows (x64) and Linux (x86_64) into resources/bin, and fetches the Silero VAD model into
// resources/vad. The Mac build stays in native.sh; this one uses the same pinned whisper.cpp and the same patch,
// plus native/whisper-vad-threads.patch: VAD ran on a fixed 4 threads, which on a 2-core computer made it so slow the
// first chunk never came back (Macs have 8 cores or more, so native.sh does without it).
//
// One whisper-server with its backends as separate libraries (GGML_BACKEND_DL): at start it loads the best CPU
// variant for the computer it runs on, and Vulkan when a graphics driver has it. Without a Vulkan driver it runs on the
// CPU, so there is no separate CPU build to choose between. GGML_NATIVE=OFF so nothing is tuned to the build machine
// (that would crash on older CPUs). No OpenMP and a static C++ runtime on Windows, so it needs nothing installed.
//
// Needs git, cmake and a C++ compiler (Visual Studio 2022 on Windows), plus the Vulkan SDK (VULKAN_SDK set).
// --cpu-only builds without Vulkan, for a quick local build without the SDK.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037' // v1.9.5, as in native.sh
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin'
const VAD_SHA256 = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'

const win = process.platform === 'win32'
if (process.platform !== 'win32' && process.platform !== 'linux') process.exit(0)
const cpuOnly = process.argv.includes('--cpu-only')
const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = fileURLToPath(import.meta.url)
const patch = join(app, 'native', 'whisper-server.patch')
const vadPatch = join(app, 'native', 'whisper-vad-threads.patch')
const dir = join(app, 'native', '.whisper-build')
const bin = join(app, 'resources', 'bin')
const out = join(bin, win ? 'whisper-server.exe' : 'whisper-server')

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed`); process.exit(1) }
  return r
}
const git = (...args) => run('git', ['-C', dir, ...args])
const newer = (a, b) => statSync(a).mtimeMs > statSync(b).mtimeMs

if (!existsSync(out) || newer(script, out) || newer(patch, out) || newer(vadPatch, out)) {
  if (!cpuOnly && !process.env.VULKAN_SDK && win) { console.error('the Vulkan SDK is needed (set VULKAN_SDK), or pass --cpu-only'); process.exit(1) }
  if (!existsSync(join(dir, '.git'))) run('git', ['clone', '--quiet', 'https://github.com/ggml-org/whisper.cpp.git', dir])
  git('checkout', '--quiet', '--force', WHISPER_COMMIT)
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  if (head !== WHISPER_COMMIT) { console.error(`whisper.cpp is not at ${WHISPER_COMMIT}`); process.exit(1) }
  git('apply', patch)
  git('apply', vadPatch)

  const build = join(dir, 'build')
  rmSync(build, { recursive: true, force: true })
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON',
    '-DGGML_NATIVE=OFF', `-DGGML_VULKAN=${cpuOnly ? 'OFF' : 'ON'}`, '-DGGML_OPENMP=OFF',
    '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=ON', '-DWHISPER_SDL2=OFF', '-DWHISPER_CURL=OFF',
  ]
  if (win) {
    // the C++ runtime inside each file: a computer without the Visual C++ Redistributable runs it too
    flags.push('-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
  } else {
    // the libraries sit next to whisper-server and are found there; plain names, no version symlinks to package
    flags.push('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=$ORIGIN', '-DCMAKE_PLATFORM_NO_VERSIONED_SONAME=ON')
  }
  run('cmake', ['-S', dir, '-B', build, ...flags])
  // ggml depends on its backends (GGML_BACKEND_DL), so this builds them too
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(cpus().length)])

  const built = win ? join(build, 'bin', 'Release') : join(build, 'bin')
  mkdirSync(bin, { recursive: true })
  const libs = readdirSync(built).filter((f) => win ? f.endsWith('.dll') : /^lib.*\.so$/.test(f))
  for (const f of readdirSync(bin)) if (win ? f.endsWith('.dll') : /^lib.*\.so$/.test(f)) rmSync(join(bin, f))
  for (const f of libs) copyFileSync(join(built, f), join(bin, f))
  copyFileSync(join(built, win ? 'whisper-server.exe' : 'whisper-server'), out)
  if (win) utf8Manifest(out)
  console.log(`built ${out} with ${libs.join(', ')}`)
}

// Silero VAD, the same file and checksum as native.sh
const vad = join(app, 'resources', 'vad', 'ggml-silero-v6.2.0.bin')
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
if (!existsSync(vad) || sha(vad) !== VAD_SHA256) {
  mkdirSync(dirname(vad), { recursive: true })
  let res
  for (let i = 0; i < 3 && !res?.ok; i++) res = await fetch(VAD_URL).catch(() => undefined)
  if (!res?.ok) { console.error('the VAD model could not be fetched'); process.exit(1) }
  writeFileSync(vad + '.part', Buffer.from(await res.arrayBuffer()))
  if (sha(vad + '.part') !== VAD_SHA256) { rmSync(vad + '.part'); console.error("the VAD model's checksum is wrong"); process.exit(1) }
  renameSync(vad + '.part', vad)
  console.log(`fetched ${vad}`)
}

/**
 * Windows hands a program its arguments in the old code page, so a model path containing non-ASCII characters reached whisper.cpp
 * as bytes it read as broken UTF-8. With UTF-8 as the program's code page (Windows 10 1903 and later) the path arrives
 * as UTF-8, which is what whisper.cpp expects. mt.exe (Windows SDK) replaces the default manifest with this one.
 */
function utf8Manifest(exe) {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin'
  const mt = readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse()
    .map((v) => join(kits, v, 'x64', 'mt.exe')).find((p) => existsSync(p))
  if (!mt) { console.error('mt.exe (Windows SDK) is needed'); process.exit(1) }
  const manifest = join(dir, 'build', 'utf8.manifest')
  writeFileSync(manifest, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings><activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage></windowsSettings>
  </application>
</assembly>
`)
  run(mt, ['-nologo', '-manifest', manifest, `-outputresource:${exe};#1`])
}
