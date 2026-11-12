import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

const state = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  handlers: new Map<string, (...args: any[]) => void>(),
}))
vi.mock('electron', () => ({
  app: { name: 'Yogurt' },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => { state.templates.push(template); return template },
    setApplicationMenu: vi.fn(),
  },
  ipcMain: { on: (channel: string, handler: (...args: any[]) => void) => state.handlers.set(channel, handler) },
}))
vi.mock('../src/shared/i18n', () => ({ t: (text: string) => text, onLanguage: vi.fn() }))
import { appMenuTemplate, installAppMenu } from '../src/main/appMenu'

const sidebarItem = (template = state.templates.at(-1)!) => template
  .flatMap(item => Array.isArray(item.submenu) ? item.submenu : [])
  .find(item => item.id === 'toggle-sidebar')!

beforeEach(() => { state.templates.length = 0; state.handlers.clear() })

it('documents the native sidebar shortcut and names the action for the current state', () => {
  const toggle = vi.fn()
  for (const [open, label, enabled] of [[true, 'Hide Sidebar', true], [false, 'Show Sidebar', true], [null, 'Show Sidebar', false]] as const) {
    expect(sidebarItem(appMenuTemplate('Yogurt', { open, toggle }))).toMatchObject({
      label, enabled, accelerator: 'Control+Command+S',
    })
  }
})

it('accepts sidebar state only from the main window and sends the menu action back there', () => {
  const webContents = { send: vi.fn() }
  let main: BrowserWindow | undefined = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  installAppMenu(() => main)
  expect(sidebarItem()).toMatchObject({ enabled: false })
  const report = state.handlers.get('sidebar:state')!
  expect(report).toBeTypeOf('function')
  report({ sender: webContents }, true)
  expect(sidebarItem()).toMatchObject({ label: 'Hide Sidebar', enabled: true })
  const before = state.templates.length
  report({ sender: {} }, false)
  report({ sender: webContents }, 'false')
  expect(state.templates).toHaveLength(before)
  ;(sidebarItem().click as () => void)()
  expect(webContents.send).toHaveBeenCalledExactlyOnceWith('sidebar:toggle')
  report({ sender: webContents }, false)
  expect(sidebarItem()).toMatchObject({ label: 'Show Sidebar', enabled: true })
  report({ sender: webContents }, null)
  expect(sidebarItem()).toMatchObject({ enabled: false })
  ;(sidebarItem().click as () => void)()
  main = undefined
  ;(sidebarItem().click as () => void)()
  expect(webContents.send).toHaveBeenCalledTimes(1)
})

it('offers reopen shortcuts only while the main window is hidden, without changing its route', () => {
  let visible = false
  const main = { isDestroyed: () => false, isVisible: () => visible } as BrowserWindow
  const reopen = vi.fn()
  const refresh = installAppMenu(() => main, reopen)
  const shortcuts = () => state.templates.at(-1)!.flatMap(item => Array.isArray(item.submenu) ? item.submenu : [])
    .filter(item => item.id?.startsWith('reopen-'))
  expect(shortcuts().map(item => item.accelerator)).toEqual(['Command+N', 'Command+J'])
  for (const item of shortcuts()) (item.click as () => void)()
  expect(reopen).toHaveBeenCalledTimes(2)
  visible = true; refresh()
  expect(shortcuts()).toEqual([]) // The renderer keeps its existing shortcuts while visible.
})

describe('Windows and Linux', () => {
  const all = (template: MenuItemConstructorOptions[]) => template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : [])
  it("have no app menu or the Mac's own items, and use Ctrl", () => {
    for (const os of ['win32', 'linux']) {
      const template = appMenuTemplate('Yogurt', { open: true, toggle: vi.fn() }, vi.fn(), os)
      expect(template.map(item => item.label)).toEqual(['File', 'Edit', 'View', 'Window'])
      const roles = all(template).map(item => item.role).filter(Boolean)
      for (const mac of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'front', 'zoom']) expect(roles).not.toContain(mac)
      expect(roles).toEqual(expect.arrayContaining(['close', 'quit', 'undo', 'copy', 'paste', 'reload', 'toggleDevTools', 'zoomIn', 'togglefullscreen', 'minimize']))
      expect(sidebarItem(template)).toMatchObject({ accelerator: 'Ctrl+Shift+S' })
      expect(all(template).find(item => item.role === 'quit')).toMatchObject({ accelerator: 'Ctrl+Q' })
      // no window can be focused while it's hidden there, so no hidden reopen shortcuts
      expect(all(template).filter(item => item.id?.startsWith('reopen-'))).toEqual([])
      expect(JSON.stringify(template)).not.toContain('Command')
    }
  })
  it('hides the menu bar itself, keeping its shortcuts', () => {
    installAppMenu(() => undefined, undefined, 'win32')
    expect(state.templates.at(-1)!.map(item => item.label)).toEqual(['File', 'Edit', 'View', 'Window'])
  })
})
