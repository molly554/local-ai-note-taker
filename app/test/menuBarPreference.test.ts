import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en-US'] }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, BrowserWindow: {}, nativeTheme: {} }))
import { hookPreferences } from '../src/main/preferences'
import { loadSettings, updateSettings } from '../src/main/settings'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); handlers.clear() })
it('defaults on, persists off across reloads, rejects non-booleans and applies changes immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-menu-pref-')); dirs.push(dir)
  const file = join(dir, 'settings.json')
  const setTrayVisible = vi.fn()
  const deps = { file, permissions: {} as Parameters<typeof hookPreferences>[0]['permissions'], ask: false, setLogin: vi.fn(), loginOn: () => false, macName: () => 'Dana', relaunch: () => false, setTrayVisible }
  hookPreferences(deps)
  const get = () => handlers.get('settings:get')!()
  const set = (value: unknown) => handlers.get('settings:menu-bar')!(null, value)
  expect(get().showInMenuBar).toBe(true)
  updateSettings(file, { openAtLogin: true })
  set(false)
  expect(loadSettings(file)).toMatchObject({ showInMenuBar: false, openAtLogin: true })
  expect(setTrayVisible).toHaveBeenLastCalledWith(false)
  hookPreferences(deps)
  expect(get().showInMenuBar).toBe(false)
  for (const value of [null, 'true', 1, undefined]) set(value)
  expect(setTrayVisible).toHaveBeenCalledTimes(1)
  set(true)
  expect(get().showInMenuBar).toBe(true)
  expect(loadSettings(file).showInMenuBar).toBeUndefined()
  expect(setTrayVisible).toHaveBeenLastCalledWith(true)
})
