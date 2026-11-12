import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { hasTrayHost, nextTrayEvent, trayItems, trayLook, trayTitle } from '../src/main/trayMenu'
import { setLanguage } from '../src/shared/i18n'
const now = new Date(2026, 10, 9, 13).getTime()
const event = { id: 'event', title: 'Launch planning', start: now + 3600000, end: now + 7200000, attendees: [], url: 'https://example.com/call' }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); setLanguage('en') })
afterEach(() => vi.useRealTimers())
it('idle has recording, Ask, disabled empty Recent and navigation in the approved order', () => {
  const items = trayItems(null)
  expect(items.map(i => i.id)).toEqual(['new', 'ask', 'recent', 'sep', 'open', 'settings', 'sep', 'quit'])
  expect(items.find(i => i.id === 'recent')).toMatchObject({ enabled: false, submenu: [] })
  expect(items.find(i => i.id === 'settings')?.accelerator).toBe('Command+,')
})
it('shows only a current or later-today meeting-shaped event, with optional Join', () => {
  const personal = { ...event, attendees: [], url: null }
  expect(nextTrayEvent([personal], now)).toBeUndefined()
  expect(nextTrayEvent([{ ...event, start: now + 86400000 }], now)).toBeUndefined()
  expect(nextTrayEvent([{ ...event, end: now }], now)).toBeUndefined()
  expect(nextTrayEvent([event, { ...event, id: 'live', start: now - 1000 }], now)?.id).toBe('live')
  expect(trayItems(null, event).slice(0, 2).map(i => i.id)).toEqual(['next', 'join'])
  expect(trayItems(null, event)[0].label).toBe('Launch planning · 2:00 PM')
  const live = { ...event, start: now - 1000, url: null, attendees: [{ name: 'Dana', email: 'dana@example.com' }] }
  expect(trayItems(null, live)[0].label).toBe('Now: Launch planning')
  expect(trayItems(null, live).some(i => i.id === 'join')).toBe(false)
})
it('recording has pause and Finish; paused has Resume; neither shows next meeting or Start', () => {
  for (const paused of [false, true]) {
    const items = trayItems({ title: 'Standup', paused }, event)
    expect(items.map(i => i.id)).toEqual(['status', 'pause', 'stop', 'sep', 'ask', 'open', 'recent', 'settings', 'sep', 'quit'])
    expect(items[0]).toMatchObject({ enabled: false, label: `${paused ? 'Paused' : 'Recording'}: Standup` })
    expect(items[1].label).toBe(paused ? 'Resume recording' : 'Pause recording')
    expect(items[2].label).toBe('Finish recording')
  }
})
it('Recent keeps the last five by start, with reusable dates and note targets', () => {
  const recent = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: `Note ${i}`, startedAt: now - i * 86400000 })).reverse()
  const submenu = trayItems(null, undefined, recent).find(i => i.id === 'recent')!.submenu!
  expect(submenu).toHaveLength(5)
  expect(submenu[0]).toMatchObject({ id: 'note:0', label: 'Note 0 · Today' })
  expect(submenu[1].label).toBe('Note 1 · Yesterday')
  expect(submenu[4].label).toBe('Note 4 · Nov 5')
})
it('formats recording time, paused time, long recordings and idle', () => {
  expect(trayTitle(null)).toBe('')
  expect(trayTitle({ elapsedMs: 723999, paused: false })).toBe('● 12:03')
  expect(trayTitle({ elapsedMs: 723999, paused: true })).toBe('12:03')
  expect(trayTitle({ elapsedMs: 3661000, paused: false })).toBe('● 1:01:01')
})

describe('Windows and Linux tray', () => {
  it('Settings shows Ctrl there and ⌘ on a Mac', () => {
    const settings = (os?: string) => trayItems(null, undefined, [], Date.now(), os).find(i => i.id === 'settings')?.accelerator
    expect([settings(), settings('darwin'), settings('win32'), settings('linux')]).toEqual(['Command+,', 'Command+,', 'Ctrl+,', 'Ctrl+,'])
  })
  it('a Mac keeps its template icon and timer title', () => {
    expect(trayLook('darwin', null, 0)).toEqual({ icon: 'tray', template: true, title: '', tooltip: 'Yogurt' })
    expect(trayLook('darwin', { paused: false }, 723000)).toEqual({ icon: 'tray', template: true, title: '● 12:03', tooltip: 'Yogurt is recording' })
    expect(trayLook('darwin', { paused: true }, 723000)).toEqual({ icon: 'tray', template: true, title: '12:03', tooltip: 'Recording paused' })
  })
  it('elsewhere a colour icon, a recording one while it records, and the time in the tooltip (no title there)', () => {
    for (const os of ['win32', 'linux']) {
      expect(trayLook(os, null, 0)).toEqual({ icon: 'tray-color', template: false, title: null, tooltip: 'Yogurt' })
      expect(trayLook(os, { paused: false }, 723000)).toEqual({ icon: 'tray-recording', template: false, title: null, tooltip: 'Yogurt is recording · 12:03' })
      expect(trayLook(os, { paused: true }, 723000)).toEqual({ icon: 'tray-color', template: false, title: null, tooltip: 'Recording paused · 12:03' })
    }
  })
  it('Linux has a tray only when a StatusNotifier host answers (GNOME needs its AppIndicator extension)', () => {
    expect(hasTrayHost('method return time=1 sender=org.freedesktop.DBus\n   boolean true\n')).toBe(true)
    expect(hasTrayHost('method return\n   boolean false\n')).toBe(false)
    expect(hasTrayHost('')).toBe(false)
  })
})
