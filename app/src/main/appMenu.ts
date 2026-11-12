import { app, ipcMain, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { onLanguage, t } from '../shared/i18n'

/**
 * The Mac's menu bar for Yogurt: Electron's own menu, with every label in the interface language
 * (Electron's are English only). The roles keep what each item does and its shortcut.
 */
export function appMenuTemplate(name = app.name, sidebar?: { open: boolean | null; toggle(): void }, reopen?: () => void, os = 'darwin'): MenuItemConstructorOptions[] {
  if (os !== 'darwin') return pcMenuTemplate(sidebar)
  return [
    { label: name, submenu: [
      { role: 'about', label: t('About {app}', { app: name }) },
      { type: 'separator' },
      { role: 'services', label: t('Services') },
      { type: 'separator' },
      { role: 'hide', label: t('Hide {app}', { app: name }) },
      { role: 'hideOthers', label: t('Hide Others') },
      { role: 'unhide', label: t('Show All') },
      { type: 'separator' },
      { role: 'quit', label: t('Quit {app}', { app: name }) },
    ] },
    { label: t('File'), submenu: [
      // With no visible renderer, these app-local shortcuts only bring the retained window back.
      ...(reopen ? ['N', 'J'].map(key => ({ id: `reopen-${key}`, label: t('Open Yogurt'), accelerator: `Command+${key}`, visible: false, acceleratorWorksWhenHidden: true, click: reopen })) : []),
      { role: 'close', label: t('Close Window') },
    ] },
    { label: t('Edit'), submenu: [
      { role: 'undo', label: t('Undo') },
      { role: 'redo', label: t('Redo') },
      { type: 'separator' },
      { role: 'cut', label: t('Cut') },
      { role: 'copy', label: t('Copy') },
      { role: 'paste', label: t('Paste') },
      { role: 'pasteAndMatchStyle', label: t('Paste and Match Style') },
      { role: 'delete', label: t('Delete') },
      { role: 'selectAll', label: t('Select All') },
    ] },
    { label: t('View'), submenu: [
      { id: 'toggle-sidebar', label: sidebar?.open ? t('Hide Sidebar') : t('Show Sidebar'), accelerator: 'Control+Command+S', enabled: sidebar?.open != null, click: () => sidebar?.toggle() },
      { type: 'separator' },
      { role: 'reload', label: t('Reload') },
      { role: 'forceReload', label: t('Force Reload') },
      { role: 'toggleDevTools', label: t('Toggle Developer Tools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('Actual Size') },
      { role: 'zoomIn', label: t('Zoom In') },
      { role: 'zoomOut', label: t('Zoom Out') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('Toggle Full Screen') },
    ] },
    { role: 'windowMenu', label: t('Window'), submenu: [
      { role: 'minimize', label: t('Minimize') },
      { role: 'zoom', label: t('Zoom') },
      { type: 'separator' },
      { role: 'front', label: t('Bring All to Front') },
    ] },
  ]
}

/**
 * Windows and Linux: no app menu and no Mac-only items. The windows hide the menu bar; the menu stays
 * for its shortcuts (zoom, reload, the sidebar), with Ctrl.
 */
function pcMenuTemplate(sidebar?: { open: boolean | null; toggle(): void }): MenuItemConstructorOptions[] {
  return [
    { label: t('File'), submenu: [
      { role: 'close', label: t('Close Window'), accelerator: 'Ctrl+W' },
      { role: 'quit', label: t('Quit {app}', { app: 'Yogurt' }), accelerator: 'Ctrl+Q' },
    ] },
    { label: t('Edit'), submenu: [
      { role: 'undo', label: t('Undo') },
      { role: 'redo', label: t('Redo') },
      { type: 'separator' },
      { role: 'cut', label: t('Cut') },
      { role: 'copy', label: t('Copy') },
      { role: 'paste', label: t('Paste') },
      { role: 'pasteAndMatchStyle', label: t('Paste and Match Style'), accelerator: 'Ctrl+Shift+V' },
      { role: 'delete', label: t('Delete') },
      { role: 'selectAll', label: t('Select All') },
    ] },
    { label: t('View'), submenu: [
      { id: 'toggle-sidebar', label: sidebar?.open ? t('Hide Sidebar') : t('Show Sidebar'), accelerator: 'Ctrl+Shift+S', enabled: sidebar?.open != null, click: () => sidebar?.toggle() },
      { type: 'separator' },
      { role: 'reload', label: t('Reload') },
      { role: 'forceReload', label: t('Force Reload') },
      { role: 'toggleDevTools', label: t('Toggle Developer Tools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('Actual Size') },
      { role: 'zoomIn', label: t('Zoom In') },
      { role: 'zoomOut', label: t('Zoom Out') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('Toggle Full Screen') },
    ] },
    { label: t('Window'), submenu: [
      { role: 'minimize', label: t('Minimize'), accelerator: 'Ctrl+M' },
    ] },
  ]
}

/** Sets the menu, and sets it again when the interface language changes */
export function installAppMenu(mainWindow: () => BrowserWindow | undefined, reopen?: () => void, os = 'darwin') {
  let open: boolean | null = null
  const toggle = () => {
    const window = mainWindow()
    if (open !== null && window && !window.isDestroyed()) window.webContents.send('sidebar:toggle')
  }
  const set = () => Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name, { open, toggle }, reopen && !mainWindow()?.isVisible() ? reopen : undefined, os)))
  ipcMain.on('sidebar:state', (event, value: unknown) => {
    if (event.sender !== mainWindow()?.webContents || (value !== null && typeof value !== 'boolean') || value === open) return
    open = value
    set()
  })
  set()
  onLanguage(set)
  return set
}
