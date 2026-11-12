import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ meeting: null as null | { id: string; title: string }, paused: false, change: () => {}, recording: (_e: { t: string }) => {}, language: () => {}, trays: [] as any[] }))
vi.mock('electron', () => ({
  app: { quit: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: (items: unknown) => items },
  nativeImage: { createFromPath: (path: string) => ({ path, setTemplateImage: vi.fn() }) },
  Tray: class {
    on = vi.fn()
    destroy = vi.fn()
    setContextMenu = vi.fn()
    setTitle = vi.fn()
    setToolTip = vi.fn()
    setImage = vi.fn()
    image: any
    constructor(image: any) { this.image = image; state.trays.push(this) }
  },
}))
vi.mock('../src/main/meeting', () => ({ activeMeeting: () => state.meeting, onMeetingChange: (fn: () => void) => { state.change = fn } }))
vi.mock('../src/main/capture', () => ({ recordingPaused: () => state.paused, onRecordingEvent: (fn: typeof state.recording) => { state.recording = fn } }))
vi.mock('../src/shared/i18n', () => ({ language: () => 'en', t: (text: string, values?: Record<string, string>) => text.replace('{title}', values?.title ?? ''), onLanguage: (fn: () => void) => { state.language = fn } }))
const basename = (p: string) => p.split(/[\\/]/).at(-1)
import { createTray } from '../src/main/tray'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
beforeEach(() => { vi.useFakeTimers(); state.trays = []; state.meeting = null; state.paused = false })
const actions = () => ({ open: vi.fn(), newNote: vi.fn(), stop: vi.fn(), pause: vi.fn(), ask: vi.fn(), settings: vi.fn(), openNote: vi.fn(), events: vi.fn(async () => [] as import('../src/main/calendar').CalEvent[]), event: vi.fn(async () => {}), recent: () => [], elapsed: () => 723000 })

it('creates by default, destroys immediately, and recreates with the current recording state', () => {
  const tray = createTray({ show: true, ...actions() })
  expect(state.trays).toHaveLength(1)
  tray.setVisible(false)
  tray.setVisible(false)
  expect(state.trays[0].destroy).toHaveBeenCalledTimes(1)
  state.meeting = { id: 'm1', title: 'Standup' }
  state.change(); state.language(); state.recording({ t: 'paused' })
  expect(state.trays).toHaveLength(1)
  tray.setVisible(true)
  tray.setVisible(true)
  expect(state.trays).toHaveLength(2)
  expect(state.trays[1].setTitle).toHaveBeenLastCalledWith('● 12:03', { fontType: 'monospacedDigit' })
  expect(state.trays[1].setContextMenu).toHaveBeenCalled()
})

it('starts hidden and keeps menu hooks working during recording and pause', () => {
  const d = actions()
  const tray = createTray({ show: true, visible: false, ...d })
  expect(state.trays).toHaveLength(0)
  tray.click('open'); tray.click('new')
  expect(d.open).toHaveBeenCalledOnce(); expect(d.newNote).toHaveBeenCalledOnce()
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  expect(tray.items()).toContain('Finish recording')
  tray.click('stop'); expect(d.stop).toHaveBeenCalledWith('m1')
  state.paused = true; state.recording({ t: 'paused' })
  expect(state.trays).toHaveLength(0)
  tray.setVisible(true)
  expect(state.trays[0].setTitle).toHaveBeenLastCalledWith('12:03', { fontType: 'monospacedDigit' })
  expect(state.trays[0].setToolTip).toHaveBeenLastCalledWith('Recording paused')
})

it('never creates a native icon in background tests, even when toggled on', () => {
  const d = actions()
  const tray = createTray({ show: false, ...d })
  tray.setVisible(false); tray.setVisible(true)
  expect(state.trays).toHaveLength(0)
  expect(tray.items()).toContain('Open Yogurt')
  tray.click('open'); expect(d.open).toHaveBeenCalledOnce()
})

it('updates the title each second and dispatches existing actions, including while hidden', async () => {
  const d = actions(), tray = createTray({ show: true, ...d })
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  state.trays[0].setTitle.mockClear()
  vi.advanceTimersByTime(3000)
  expect(state.trays[0].setTitle).toHaveBeenCalledTimes(3)
  tray.click('pause'); expect(d.pause).toHaveBeenLastCalledWith('m1', true)
  state.paused = true
  tray.click('pause'); expect(d.pause).toHaveBeenLastCalledWith('m1', false)
  tray.setVisible(false)
  tray.click('ask'); tray.click('settings'); tray.click('note:m1')
  expect(d.ask).toHaveBeenCalledOnce(); expect(d.settings).toHaveBeenCalledOnce(); expect(d.openNote).toHaveBeenCalledWith('m1')
  vi.advanceTimersByTime(3000)
  expect(state.trays).toHaveLength(1)
})

it('refreshes calendar targets without letting an older read overwrite a newer one', async () => {
  const d = actions()
  const now = Date.now(), event = { id: 'event', title: 'Next call', start: now, end: now + 3600000, url: 'https://example.com', attendees: [] }
  const tray = createTray({ show: false, ...d })
  let finish!: (events: typeof event[]) => void
  d.events.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = tray.refreshCalendar()
  d.events.mockResolvedValueOnce([event]); await tray.refreshCalendar()
  finish([]); await old
  expect(tray.items()[0]).toBe('Now: Next call')
  tray.click('next'); expect(d.event).toHaveBeenLastCalledWith(event, false)
  tray.click('join'); expect(d.event).toHaveBeenLastCalledWith(event, true)
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  tray.click('join'); expect(d.event).toHaveBeenCalledTimes(2)
})

it('Windows and Linux: a colour icon that turns to the recording one, the time in the tooltip, and a click opens Yogurt', () => {
  const d = actions()
  const tray = createTray({ show: true, os: 'win32', ...d })
  const icon = state.trays[0]
  expect(basename(icon.image.path)).toBe('tray-color.png')
  expect(icon.image.setTemplateImage).not.toHaveBeenCalled()
  ;(icon.on.mock.calls.find((c: any[]) => c[0] === 'click')![1] as () => void)()
  expect(d.open).toHaveBeenCalledOnce()
  state.meeting = { id: 'm1', title: 'Standup' }; state.change()
  expect(basename(icon.setImage.mock.lastCall[0].path)).toBe('tray-recording.png')
  expect(icon.setTitle).not.toHaveBeenCalled()
  expect(icon.setToolTip).toHaveBeenLastCalledWith('Yogurt is recording · 12:03')
  vi.advanceTimersByTime(1000)
  expect(icon.setToolTip).toHaveBeenLastCalledWith('Yogurt is recording · 12:03')
  state.paused = true; state.recording({ t: 'paused' })
  expect(basename(icon.setImage.mock.lastCall[0].path)).toBe('tray-color.png')
  expect(tray.accelerators()).toEqual({ 'Settings…': 'Ctrl+,' })
})

it('Linux without a tray host (GNOME without its extension) says no icon is shown, so closing minimises', async () => {
  const tray = createTray({ show: true, os: 'linux', host: async () => false, ...actions() })
  expect(tray.shown()).toBe(true)
  await vi.waitFor(() => expect(tray.shown()).toBe(false))
  tray.setVisible(false)
  const mac = createTray({ show: true, ...actions() })
  expect(mac.shown()).toBe(true)
  mac.setVisible(false)
  expect(mac.shown()).toBe(false)
})
