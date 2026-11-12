// electron-builder afterPack: on Linux, `yogurt` becomes build/linux-launcher.sh and Electron moves to yogurt-bin (#8)
const { chmodSync, copyFileSync, existsSync, renameSync } = require('node:fs')
const { join } = require('node:path')

function wrapLinuxBinary(dir, name) {
  const bin = join(dir, `${name}-bin`)
  if (existsSync(bin)) throw new Error(`${bin} is already there: wrapped twice`)
  renameSync(join(dir, name), bin)
  copyFileSync(join(__dirname, '../build/linux-launcher.sh'), join(dir, name))
  chmodSync(join(dir, name), 0o755)
}

module.exports = async (context) => {
  if (context.electronPlatformName !== 'linux') return
  const { packager, appOutDir } = context
  wrapLinuxBinary(appOutDir, packager.executableName)
  // electron-builder flips the fuses after this hook, on `yogurt`: they belong on the Electron the launcher starts
  const { flipFuses } = require(require.resolve('@electron/fuses', { paths: [require.resolve('app-builder-lib')] }))
  packager.addElectronFuses = (ctx, fuses) => flipFuses(join(ctx.appOutDir, `${packager.executableName}-bin`), fuses)
}
module.exports.wrapLinuxBinary = wrapLinuxBinary
