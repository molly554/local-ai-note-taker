import { app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n'

/**
 * Mounted volumes that still hold a Yogurt.app: the disk image it was installed from.
 * Not the volume this Yogurt runs from, so opening it straight off the disk image keeps it mounted.
 */
export const installerVolumes = (exe: string, volumes: string[], hasApp: (volume: string) => boolean): string[] =>
  volumes.filter((v) => !exe.startsWith(`${v}/`) && hasApp(v))

/** Mac: once installed, offers to eject the Yogurt disk image still mounted, like well-made Mac apps do */
export async function offerInstallerEject(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  let names: string[]
  try { names = readdirSync('/Volumes') } catch { return }
  const volumes = installerVolumes(app.getPath('exe'), names.map((n) => join('/Volumes', n)), (v) => existsSync(join(v, 'Yogurt.app')))
  if (!volumes.length) return
  const { response } = await dialog.showMessageBox({
    message: t('Eject the Yogurt installer?'), buttons: [t('Eject'), t('Not now')], defaultId: 0, cancelId: 1, noLink: true,
  })
  if (response !== 0) return
  for (const v of volumes) execFile('/usr/bin/hdiutil', ['detach', v], (err) => { if (err) console.warn(`couldn't eject ${v}`, err) })
}
