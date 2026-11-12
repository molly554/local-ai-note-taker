import type { BrowserWindowConstructorOptions } from 'electron'

/** the toolbar's height: the window buttons off a Mac sit in it */
const TITLE_BAR_HEIGHT = 52

/** Windows and Linux: the system's window buttons, drawn in the colours of the bar under them (styles.css --chrome and --ink) */
export const titleBarOverlay = (dark: boolean) =>
  ({ ...(dark ? { color: '#242425', symbolColor: '#E7E6EB' } : { color: '#F3F3F3', symbolColor: '#29292C' }), height: TITLE_BAR_HEIGHT })

/**
 * The main window's frame. A Mac: inset traffic lights over native glass, as always.
 * Windows and Linux: no title or menu bar, like the Mac; the window buttons over the top-right corner (Window Controls Overlay).
 */
export function windowChrome(os: string, dark: boolean): BrowserWindowConstructorOptions {
  if (os === 'darwin') {
    // Match the theme until first paint, then restore the native glass behind the chrome.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, backgroundColor: dark ? '#1B1B1D' : '#FFFFFF', vibrancy: 'under-window', visualEffectState: 'active' }
  }
  const overlay = titleBarOverlay(dark)
  return { titleBarStyle: 'hidden', titleBarOverlay: overlay, autoHideMenuBar: true, backgroundColor: overlay.color }
}
