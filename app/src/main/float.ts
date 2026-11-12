type Floating = { setAlwaysOnTop(on: boolean, level: 'floating'): void; setVisibleOnAllWorkspaces(on: boolean, o: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void }

/**
 * Keeps a small window (the widget, the "Take notes?" card) above other apps, full-screen calls included.
 * skipTransformProcessType: otherwise Electron turns the whole app into a menu-bar-only one and the Dock icon goes.
 */
export function floatOverFullScreen(w: Floating): void {
  w.setAlwaysOnTop(true, 'floating')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
}

/**
 * The floating windows' type. A Mac: the widget is a non-activating panel, the card a plain window, as always.
 * Windows and Linux have no panels: a tool window stays out of Alt+Tab and the taskbar; focusable: false keeps it from taking focus.
 */
export const floatingType = (os: string, mac?: 'panel'): 'panel' | 'toolbar' | undefined => (os === 'darwin' ? mac : 'toolbar')
