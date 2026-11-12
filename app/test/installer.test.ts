import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, dialog: {} }))
import { installerVolumes } from '../src/main/installer'

it('finds the mounted Yogurt disk image, but not the one Yogurt runs from or volumes without Yogurt', () => {
  const withApp = new Set(['/Volumes/Yogurt', '/Volumes/Yogurt 1'])
  const has = (v: string) => withApp.has(v)
  const volumes = ['/Volumes/Macintosh HD', '/Volumes/Yogurt', '/Volumes/Yogurt 1', '/Volumes/Backup']
  expect(installerVolumes('/Applications/Yogurt.app/Contents/MacOS/Yogurt', volumes, has)).toEqual(['/Volumes/Yogurt', '/Volumes/Yogurt 1'])
  expect(installerVolumes('/Volumes/Yogurt/Yogurt.app/Contents/MacOS/Yogurt', volumes, has)).toEqual(['/Volumes/Yogurt 1'])
})
