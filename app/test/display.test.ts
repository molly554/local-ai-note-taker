import { expect, it } from 'vitest'
import { x11Relaunch } from '../src/main/display'

const wayland = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }

it('Linux on Wayland starts again through XWayland, where the widget and the card can float and stay put', () => {
  expect(x11Relaunch('linux', ['/usr/lib/electron', '.'], wayland, '/usr/lib/electron')).toEqual({ execPath: '/usr/lib/electron', args: ['.', '--ozone-platform=x11'] })
})

it('never twice, never without XWayland, never on X11, a Mac or Windows, and never in tests', () => {
  expect(x11Relaunch('linux', ['y', '--ozone-platform=x11'], wayland, 'y')).toBeNull()
  expect(x11Relaunch('linux', ['y', '--ozone-platform=wayland'], wayland, 'y')).toBeNull()
  expect(x11Relaunch('linux', ['y'], { WAYLAND_DISPLAY: 'wayland-0' }, 'y')).toBeNull()
  expect(x11Relaunch('linux', ['y'], { DISPLAY: ':0' }, 'y')).toBeNull()
  expect(x11Relaunch('darwin', ['y'], wayland, 'y')).toBeNull()
  expect(x11Relaunch('win32', ['y'], wayland, 'y')).toBeNull()
  expect(x11Relaunch('linux', ['y'], { ...wayland, YOGURT_FAKE: '1' }, 'y')).toBeNull()
  // the AppImage's launcher picks X11 itself: starting it again couldn't mount it (#8)
  expect(x11Relaunch('linux', ['/tmp/.mount_x/yogurt-bin'], { ...wayland, APPIMAGE: '/home/sam/Yogurt.AppImage' }, '/tmp/.mount_x/yogurt-bin')).toBeNull()
})
