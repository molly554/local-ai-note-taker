import { describe, expect, it } from 'vitest'
import { capabilities, commandKey, helperFile, micListHelper, platformOf, shortcutLabel, supportedKinds } from '../src/shared/platform'
import { PERMISSION_KINDS } from '../src/main/permissions'

describe('what each computer can do', () => {
  it('a Mac has every feature, exactly as before', () => {
    expect(capabilities('darwin')).toEqual({ calendar: true, callNames: true, permissionPrompts: true, mediaPause: true })
  })
  it('Windows and Linux have no calendar, no names from calls (yet) and nothing to ask permission for up front', () => {
    for (const p of ['win32', 'linux']) expect(capabilities(p)).toEqual({ calendar: false, callNames: false, permissionPrompts: false, mediaPause: false })
  })
  it('only fake mode can pretend to be another computer, so the Mac CI can try the Windows and Linux screens', () => {
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'win32' })).toBe('win32')
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'linux' })).toBe('linux')
    expect(platformOf('darwin', { YOGURT_FAKE_PLATFORM: 'win32' })).toBe('darwin')
    expect(platformOf('darwin', { YOGURT_FAKE: '1', YOGURT_FAKE_PLATFORM: 'beos' })).toBe('darwin')
    expect(platformOf('linux', {})).toBe('linux')
  })
})

describe('helper programs', () => {
  it('a Mac keeps its helpers names', () => {
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'darwin'))).toEqual(['yogurt-mac', 'yogurt-audio', 'yogurt-mcp', 'whisper-server'])
  })
  it('Windows and Linux get yogurt-system in place of yogurt-mac, and .exe on Windows', () => {
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'linux'))).toEqual(['yogurt-system', 'yogurt-audio', 'yogurt-mcp', 'whisper-server'])
    expect(['system', 'audio', 'mcp', 'whisper'].map((h) => helperFile(h as never, 'win32'))).toEqual(['yogurt-system.exe', 'yogurt-audio.exe', 'yogurt-mcp.exe', 'whisper-server.exe'])
  })
})

describe('the mic list', () => {
  it("comes from yogurt-mac on a Mac and from the recorder itself on Windows and Linux", () => {
    expect(['darwin', 'win32', 'linux'].map(micListHelper)).toEqual(['system', 'audio', 'audio'])
  })
})

describe('permissions to ask for', () => {
  it('a Mac asks for every one, in the same order', () => {
    expect(supportedKinds(capabilities('darwin'))).toEqual(PERMISSION_KINDS)
  })
  it('without a calendar or names from calls, those are never asked', () => {
    expect(supportedKinds(capabilities('win32'))).toEqual(['mic', 'systemAudio', 'notifications'])
  })
})

describe('shortcuts', () => {
  it('a Mac keeps its own signs, exactly as written', () => {
    for (const k of ['⌘K', '⇧⌘C', '⌃⌘S', '⌥⇧⌘V', '⌃⌘F', '⌘−', '↑ ↓', 'esc']) expect(shortcutLabel(k, 'darwin')).toBe(k)
  })
  it('Windows and Linux write Ctrl, Shift and Alt, in that order', () => {
    for (const p of ['win32', 'linux']) {
      expect(['⌘K', '⌘,', '⇧⌘C', '⇧⌘Z', '⌥F10', '⌘−', '↑ ↓', '↵', 'esc'].map((k) => shortcutLabel(k, p)))
        .toEqual(['Ctrl+K', 'Ctrl+,', 'Ctrl+Shift+C', 'Ctrl+Shift+Z', 'Alt+F10', 'Ctrl+−', '↑ ↓', '↵', 'esc'])
    }
  })
  it("Windows and Linux use their own keys where a Mac's would mean something else", () => {
    expect(['⌃⌘S', '⌃⌘F', '⌥⇧⌘V'].map((k) => shortcutLabel(k, 'win32'))).toEqual(['Ctrl+Shift+S', 'F11', 'Ctrl+Shift+V'])
  })
  it('the command key is ⌘ on a Mac and Ctrl elsewhere', () => {
    const key = (metaKey: boolean, ctrlKey: boolean) => ({ metaKey, ctrlKey })
    expect([key(true, false), key(false, true)].map((e) => commandKey(e, 'darwin'))).toEqual([true, false])
    expect([key(true, false), key(false, true), key(true, true)].map((e) => commandKey(e, 'win32'))).toEqual([false, true, false])
  })
})
