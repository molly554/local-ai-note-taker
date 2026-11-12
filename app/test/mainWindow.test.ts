import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { closeAction, keepMainWindow } from '../src/main/mainWindow'

function fixture(background = false, more: { closeTo?(): 'hide' | 'minimize'; glass?: boolean; lift?: boolean } = {}) {
  let quitting = false
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false),
    hide: vi.fn(), minimize: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(), moveTop: vi.fn(), setBackgroundColor: vi.fn(), setAlwaysOnTop: vi.fn(),
  })
  const activate = vi.fn()
  const show = keepMainWindow(window as unknown as BrowserWindow, { background, canClose: () => quitting, activate, ...more })
  return { window, show, activate, quit: () => { quitting = true } }
}

it('waits for first paint, then reuses the same window immediately on every show', () => {
  const { window, show, activate } = fixture()
  show(); show(true)
  expect(window.show).not.toHaveBeenCalled()
  window.emit('ready-to-show')
  expect(window.setBackgroundColor).toHaveBeenCalledExactlyOnceWith('#00000000')
  expect(window.show).toHaveBeenCalledTimes(1)
  expect(activate).toHaveBeenCalledTimes(1)
  const event = { preventDefault: vi.fn() }
  window.emit('close', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(window.hide).toHaveBeenCalledOnce()
  window.isMinimized.mockReturnValue(true)
  show()
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledTimes(2)
  expect(window.focus).toHaveBeenCalledTimes(2)
})

it('allows a close only after the existing quit/save gate has finished', () => {
  const { window, quit } = fixture()
  const event = { preventDefault: vi.fn() }
  quit(); window.emit('close', event)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(window.hide).not.toHaveBeenCalled()
})

it('cancels an unpainted show when closed, and never shows background or destroyed windows', () => {
  const { window, show } = fixture()
  show(); window.emit('close', { preventDefault() {} }); window.emit('ready-to-show')
  expect(window.show).not.toHaveBeenCalled()
  window.isDestroyed.mockReturnValue(true); show()
  expect(window.show).not.toHaveBeenCalled()
  const hidden = fixture(true)
  hidden.show(true); hidden.window.emit('ready-to-show'); hidden.show()
  expect(hidden.window.show).not.toHaveBeenCalled()
  expect(hidden.activate).not.toHaveBeenCalled()
})

it('Windows and Linux without a tray icon minimise on close, so Yogurt never runs out of sight; with one they hide like a Mac', () => {
  expect(['darwin', 'win32', 'linux'].map(os => closeAction(os, true))).toEqual(['hide', 'hide', 'hide'])
  expect(['darwin', 'win32', 'linux'].map(os => closeAction(os, false))).toEqual(['hide', 'minimize', 'minimize'])
  const { window } = fixture(false, { closeTo: () => 'minimize' })
  const event = { preventDefault: vi.fn() }
  window.emit('close', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(window.minimize).toHaveBeenCalledOnce()
  expect(window.hide).not.toHaveBeenCalled()
})

it('only a window with native glass (a Mac) turns clear after first paint', () => {
  const { window } = fixture(false, { glass: false })
  window.emit('ready-to-show')
  expect(window.setBackgroundColor).not.toHaveBeenCalled()
})

it('on a Mac, brought forward from the pill or a card, rises above the app in front even when macOS refuses to switch apps, then floats no longer', () => {
  const { window, show, activate } = fixture(false, { lift: true })
  window.emit('ready-to-show')
  show(true)
  expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]])
  const [up, down] = window.setAlwaysOnTop.mock.invocationCallOrder
  expect(up).toBeLessThan(window.show.mock.invocationCallOrder[0])
  expect(down).toBeGreaterThan(activate.mock.invocationCallOrder[0])
  expect(down).toBeGreaterThan(window.focus.mock.invocationCallOrder[0])
})

it('a plain show, Windows and Linux never float the window', () => {
  const mac = fixture(false, { lift: true })
  mac.window.emit('ready-to-show'); mac.show()
  expect(mac.window.setAlwaysOnTop).not.toHaveBeenCalled()
  const other = fixture()
  other.window.emit('ready-to-show'); other.show(true)
  expect(other.window.setAlwaysOnTop).not.toHaveBeenCalled()
})
