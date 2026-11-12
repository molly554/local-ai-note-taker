import { dirname } from 'node:path'

/** Launch Services retains the installed app's identity and Info.plist environment after a permission restart. */
export function relaunchOptions(platform: NodeJS.Platform, packaged: boolean, executable: string, appImage?: string) {
  // Linux: the AppImage's mount goes away when Yogurt quits, so the AppImage itself starts again
  if (platform === 'linux' && packaged && appImage) return { execPath: appImage }
  if (platform !== 'darwin' || !packaged) return undefined
  return { execPath: '/usr/bin/open', args: ['-n', '-a', dirname(dirname(dirname(executable)))] }
}
