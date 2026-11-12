import { expect, it } from 'vitest'
import { relaunchOptions } from '../src/main/relaunch'

it('reopens the exact installed Mac bundle through Launch Services without inherited Electron arguments', () => {
  expect(relaunchOptions('darwin', true, '/Users/sam/My Apps/Yogurt.app/Contents/MacOS/Yogurt')).toEqual({ execPath: '/usr/bin/open', args: ['-n', '-a', '/Users/sam/My Apps/Yogurt.app'] })
})
it('leaves development and non-Mac relaunches to Electron', () => {
  expect(relaunchOptions('darwin', false, '/dev/Electron.app/Contents/MacOS/Electron')).toBeUndefined()
  expect(relaunchOptions('win32', true, 'C:\\Yogurt.exe')).toBeUndefined()
})

it('Linux starts the AppImage itself again: its mount goes away when Yogurt quits', () => {
  expect(relaunchOptions('linux', true, '/tmp/.mount_abc/yogurt', '/home/sam/Yogurt.AppImage')).toEqual({ execPath: '/home/sam/Yogurt.AppImage' })
  expect(relaunchOptions('linux', true, '/usr/bin/yogurt')).toBeUndefined()
})
