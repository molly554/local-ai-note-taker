import { expect, it } from 'vitest'
import { titleBarOverlay, windowChrome } from '../src/main/windowChrome'

it('a Mac keeps its inset traffic lights and native glass, exactly as before', () => {
  expect(windowChrome('darwin', false)).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, backgroundColor: '#FFFFFF', vibrancy: 'under-window', visualEffectState: 'active' })
  expect(windowChrome('darwin', true)).toMatchObject({ backgroundColor: '#1B1B1D' })
})

it('Windows and Linux: no title or menu bar; the system draws its window buttons over the top right, in the sidebar colours', () => {
  for (const os of ['win32', 'linux']) {
    expect(windowChrome(os, false)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#F3F3F3', symbolColor: '#29292C', height: 52 }, autoHideMenuBar: true, backgroundColor: '#F3F3F3' })
    expect(windowChrome(os, true)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#242425', symbolColor: '#E7E6EB', height: 52 }, autoHideMenuBar: true, backgroundColor: '#242425' })
  }
  expect(titleBarOverlay(true)).toEqual({ color: '#242425', symbolColor: '#E7E6EB', height: 52 })
})
