// electron-builder's mac.sign: its usual signing, except each helper in Resources/bin gets only the entitlements it
// uses (electron-builder alone gives every nested program the same set).
const { basename, join } = require('node:path')

const HELPERS = {
  'yogurt-audio': 'entitlements.audio.plist',
  'yogurt-mac': 'entitlements.mac-helper.plist',
  'whisper-server': 'entitlements.none.plist',
  'yogurt-mcp': 'entitlements.none.plist',
}

/** The entitlements file for a helper; null for everything else (Electron's own files) */
function helperEntitlements(file, buildDir) {
  if (!file.includes('/Contents/Resources/bin/')) return null
  const name = HELPERS[basename(file)]
  // a new helper must say what it needs, rather than get the app's set by accident
  if (!name) throw new Error(`no entitlements chosen for ${file} (scripts/sign.cjs)`)
  return join(buildDir, name)
}

/** electron-builder's own signing tries 3 times, 5 s apart (Apple's timestamp server has bad moments): the same here */
async function retry(fn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 3, waitMs = 5000) {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries) throw e
      console.log(`  • signing failed (${e && e.message}), trying again in ${waitMs / 1000} s`)
      await sleep(waitMs)
    }
  }
}

async function sign(opts) {
  // an unsigned build (no certificate, e.g. CI without secrets): nothing to sign with
  if (!opts.identity) { console.log('  • no signing identity: left unsigned'); return }
  const { signAsync } = require('@electron/osx-sign')
  const buildDir = join(__dirname, '../build')
  const forFile = opts.optionsForFile
  await retry(() => signAsync({
    ...opts,
    optionsForFile: (file) => {
      const base = { ...(forFile ? forFile(file) : {}),
        ...(process.env.YOGURT_SIGN_ID === 'Yogurt Local' && process.env.YOGURT_NOTARIZE === '0' ? { timestamp: 'none' } : {}),
      }
      const own = helperEntitlements(file, buildDir)
      return own ? { ...base, entitlements: own } : base
    },
  }))
}

module.exports = sign
module.exports.default = sign
module.exports.helperEntitlements = helperEntitlements
module.exports.retry = retry
