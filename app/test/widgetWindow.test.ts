import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  cursor: { x: 500, y: 400 },
  displayEvents: new Map<string, () => void>(),
  handlers: new Map<string, (...args: any[]) => unknown>(),
  start: null as null | ((meeting: any) => void),
  stop: null as null | ((meeting: any) => void),
  change: null as null | ((meeting: any) => void),
  recording: null as null | ((event: any) => void),
  windows: [] as any[],
  notifications: [] as any[],
  fake: false,
  stopPending: false,
  supported: true,
  finished: vi.fn<() => Promise<void>>(),
  displays: [{ x: 0, y: 0, width: 1200, height: 800 }, { x: -1000, y: -200, width: 1000, height: 900 }],
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows() { return state.windows }
    bounds: any; options: any; dead = false
    webContents = { send: vi.fn(), once: (_name: string, fn: () => void) => fn() }
    constructor(options: any) { this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; state.windows.push(this) }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds: any) { this.bounds = bounds }
    setIgnoreMouseEvents = vi.fn()
    isDestroyed() { return this.dead }
    isVisible() { return false }
    on() {}
    hide() {}
    showInactive() {}
    destroy() { this.dead = true }
    loadFile() { return Promise.resolve() }
  },
  ipcMain: { on: (name: string, fn: (...args: any[]) => unknown) => state.handlers.set(name, fn), handle: vi.fn() },
  Notification: class {
    static isSupported() { return state.supported }
    options: any
    show = vi.fn(); close = vi.fn(); on = vi.fn()
    constructor(options: any) { this.options = options; state.notifications.push(this) }
  },
  screen: {
    getCursorScreenPoint: () => state.cursor,
    on: (name: string, fn: () => void) => state.displayEvents.set(name, fn),
    removeListener: (name: string) => state.displayEvents.delete(name),
    getDisplayNearestPoint: (p: { x: number; y: number }) => ({ workArea: state.displays[p.x < 0 ? 1 : 0] }),
    getDisplayMatching: (b: { x: number }) => ({ workArea: state.displays[b.x < 0 ? 1 : 0] }),
  },
}))
vi.mock('../src/main/float', async (real) => ({ ...(await real<typeof import('../src/main/float')>()), floatOverFullScreen: vi.fn() }))
vi.mock('../src/main/paths', () => ({ isFake: () => state.fake }))
vi.mock('../src/main/capture', () => ({ onRecordingEvent: (fn: (event: any) => void) => { state.recording = fn }, recordingFinished: () => state.finished() }))
vi.mock('../src/main/meeting', () => ({
  onMeetingStart: (fn: (meeting: any) => void) => { state.start = fn },
  onMeetingChange: (fn: (meeting: any) => void) => { state.change = fn }, onMeetingStop: (fn: (meeting: any) => void) => { state.stop = fn }, stopSavePending: () => state.stopPending,
}))

const send = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!({ sender: win.webContents }, ...args)
let win: any
const open = vi.fn()
let widget: ReturnType<typeof import('../src/main/widget').createWidget>
beforeEach(async () => {
  vi.useFakeTimers()
  state.cursor = { x: 500, y: 400 }
  vi.stubEnv('YOGURT_BACKGROUND', '0')
  vi.resetModules(); state.handlers.clear(); state.windows.length = 0
  state.notifications.length = 0; state.fake = false; state.stopPending = false; state.supported = true
  state.finished.mockReset().mockResolvedValue(); open.mockReset()
  const { createWidget } = await import('../src/main/widget')
  widget = createWidget({ open, stop: vi.fn(), foreground: () => false })
  state.start!({ id: 'meeting', title: 'Review', startedAt: 0 })
  win = state.windows[0]
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

describe('floating recorder placement', () => {
  it('uses one transparent, non-activating window with clicks initially passing through', () => {
    expect(state.windows).toHaveLength(1)
    expect(win.options).toMatchObject({ type: 'panel', transparent: true, frame: false, acceptFirstMouse: true, hasShadow: false, roundedCorners: false, focusable: false })
    expect(win.options.width).toBeGreaterThanOrEqual(340)
    expect(win.options.height).toBeGreaterThanOrEqual(446)
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    expect(widget.snapshot().bounds).toMatchObject({ width: 127, height: 42 })
  })
  it('uses a tool window on Windows without taking focus', async () => {
    const { createWidget } = await import('../src/main/widget')
    createWidget({ open, stop: vi.fn(), foreground: () => false, windowOs: 'win32' })
    state.start!({ id: 'meeting2', title: 'Review', startedAt: 0 })
    expect(state.windows.at(-1).options).toMatchObject({ type: 'toolbar', focusable: false, skipTaskbar: true })
  })
  it('moves the surface and pill together and remembers the pill for the next meeting', () => {
    const before = widget.snapshot().bounds!, frame = win.getBounds()
    send('widget:drag', -100, 10); send('widget:drag-end')
    const chosen = widget.snapshot().bounds!
    expect(chosen).toEqual({ ...before, x: before.x - 100, y: before.y + 10 })
    expect(win.getBounds()).toEqual({ ...frame, x: frame.x - 100, y: frame.y + 10 })
    send('widget:size', 118, 42)
    expect(widget.snapshot().bounds).toEqual({ ...chosen, x: chosen.x + 9, width: 118 })
    const resized = widget.snapshot().bounds
    state.stop!({ id: 'meeting' })
    state.start!({ id: 'next', title: 'Next meeting', startedAt: 1 })
    expect(widget.snapshot().bounds).toEqual(resized)
  })
  it('drags an expanded surface as one window and clamps all of it at the edge', async () => {
    const { widgetLayout } = await import('../src/shared/widgetMorph')
    const before = widget.snapshot().bounds!, layout = widgetLayout(before, state.displays[0])
    send('widget:surface', { ...layout.open, height: 390, radius: 16 })
    send('widget:pressed', true)
    const frame = win.getBounds()
    send('widget:drag', -100, 10)
    expect(win.getBounds()).toEqual({ ...frame, x: frame.x - 100, y: frame.y + 10 })
    expect(widget.snapshot().bounds).toEqual({ ...before, x: before.x - 100, y: before.y + 10 })
    send('widget:drag', 9999, 9999)
    const edge = win.getBounds()
    expect(edge.x + layout.open.x + layout.open.width).toBe(1200)
    expect(edge.y + layout.open.y + layout.open.height).toBe(800)
    send('widget:drag-end'); send('widget:pressed', false)
    expect(win.getBounds()).toEqual(edge)
    expect(state.windows).toHaveLength(1)
  })
  it('defers timer sizing while pressed and keeps the right edge fixed afterward', () => {
    const before = widget.snapshot().bounds!
    send('widget:pressed', true); send('widget:size', 134, 42)
    expect(widget.snapshot().bounds).toEqual(before)
    send('widget:pressed', false); send('widget:size', 134, 42)
    expect(widget.snapshot().bounds).toEqual({ ...before, x: before.x - 7, width: 134 })
  })
  it('crosses to a negative-coordinate display with successive small deltas', () => {
    const before = widget.snapshot().bounds!
    send('widget:drag', -before.x, 0)
    for (let n = 0; n < 45; n++) send('widget:drag', -4, -2)
    send('widget:drag-end')
    expect(widget.snapshot().bounds).toMatchObject({ x: -180, y: before.y - 90 })
    expect(win.getBounds().x).toBeGreaterThanOrEqual(-1000)
  })
  it('turns inward at both screen edges without changing the pill anchor', () => {
    send('widget:drag', 9999, 9999); send('widget:drag-end')
    expect(widget.snapshot().bounds).toEqual({ x: 1073, y: 758, width: 127, height: 42 })
    expect(win.getBounds().x + win.getBounds().width).toBe(1200)
    expect(win.getBounds().y + win.getBounds().height).toBe(800)
    send('widget:drag', -9999, -9999); send('widget:drag-end')
    expect(widget.snapshot().bounds).toEqual({ x: -1000, y: -200, width: 127, height: 42 })
    expect(win.getBounds()).toMatchObject({ x: -1000, y: -200 })
  })
  it('refits after display changes and removes its display listeners on stop', () => {
    send('widget:drag', 9999, 9999); send('widget:drag-end')
    const height = state.displays[0].height
    try {
      state.displays[0].height = 300
      state.displayEvents.get('display-metrics-changed')!()
      expect(widget.snapshot().bounds!.y).toBe(258)
      expect(win.getBounds()).toMatchObject({ y: 0, height: 300 })
      state.stop!({ id: 'meeting' })
      expect(state.displayEvents.size).toBe(0)
    } finally { state.displays[0].height = height }
  })
  it('rejects malformed sizing, hit regions and foreign senders', () => {
    const before = widget.snapshot().bounds
    for (const pair of [[NaN, 1], [1, Infinity], ['2', 3], [1, undefined]]) send('widget:drag', ...pair)
    for (const pair of [[NaN, 42], [601, 42], [0, 0], [118, 400]]) send('widget:size', ...pair)
    state.handlers.get('widget:drag')!({ sender: {} }, 20, 20)
    for (const shape of [null, {}, { x: 0, y: 0, width: 340, height: 400, radius: NaN }]) send('widget:surface', shape)
    expect(widget.snapshot().bounds).toEqual(before)
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)
  })
  it('passes clicks outside the actual rounded surface and keeps pointer capture during a drag', () => {
    const b = win.getBounds(), surface = { x: 20, y: 20, width: 118, height: 42, radius: 10 }
    state.cursor = { x: b.x + 30, y: b.y + 35 }
    send('widget:surface', surface)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    state.cursor = { x: b.x + 20, y: b.y + 20 }
    vi.advanceTimersByTime(16)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    send('widget:pressed', true)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    send('widget:pressed', false)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    state.cursor = { x: b.x + 30, y: b.y + 35 }
    vi.advanceTimersByTime(16)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
  })
  it('checks the pointer at frame rate only over the window, slowly elsewhere, and not at all while hidden', () => {
    const b = win.getBounds(), surface = { x: 20, y: 20, width: 118, height: 42, radius: 10 }
    state.cursor = { x: b.x - 400, y: b.y - 400 }
    send('widget:surface', surface)
    state.cursor = { x: b.x + 30, y: b.y + 35 }
    vi.advanceTimersByTime(16)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    vi.advanceTimersByTime(250)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    state.recording!({ t: 'paused', meetingId: 'meeting', paused: true, at: 100 })
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    const calls = win.setIgnoreMouseEvents.mock.calls.length, sent = win.webContents.send.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(win.setIgnoreMouseEvents.mock.calls.length).toBe(calls)
    expect(win.webContents.send.mock.calls.length).toBe(sent)
  })
  it('keeps the window and anchor through warnings, pause and resume, and forwards live words there', () => {
    const chosen = widget.snapshot().bounds
    state.recording!({ t: 'warn', code: 'no-mic' })
    expect(widget.snapshot().view?.note?.code).toBe('no-mic')
    expect(state.windows).toHaveLength(1)
    state.recording!({ t: 'paused', meetingId: 'meeting', paused: true, at: 100 })
    expect(widget.snapshot().visible).toBe(false)
    expect(win.dead).toBe(false)
    state.recording!({ t: 'paused', meetingId: 'meeting', paused: false, at: 200 })
    expect(widget.snapshot().visible).toBe(true)
    expect(widget.snapshot().bounds).toEqual(chosen)
    widget.transcript('transcript:partial', { text: 'Actual incoming words' })
    expect(win.webContents.send).toHaveBeenCalledWith('transcript:partial', { text: 'Actual incoming words' })
    state.stop!({ id: 'meeting' })
    expect(win.dead).toBe(true)
  })
})

describe('finished meeting notifications', () => {
  const stopped = { id: 'meeting', title: 'Review', state: 'stopped', endedAt: 100 }
  const finish = () => { state.stop!(stopped); state.change!(stopped) }
  it('notifies once after the recording settles, closes the pill, and opens that note on click', async () => {
    let settle!: () => void
    state.finished.mockReturnValue(new Promise<void>((resolve) => { settle = resolve }))
    finish(); finish(); state.change!(stopped)
    expect(widget.snapshot()).toMatchObject({ visible: false, bounds: null, notice: null, view: { kind: 'captured' } })
    expect(win.dead).toBe(true)
    expect(state.notifications).toHaveLength(0)
    settle(); await Promise.resolve()
    expect(state.notifications).toHaveLength(1)
    const notice = state.notifications[0]
    expect(notice.options).toEqual({ title: 'Meeting captured', body: 'Review', silent: true })
    expect(notice.show).toHaveBeenCalledOnce()
    notice.on.mock.calls.find(([name]: [string]) => name === 'click')[1]()
    expect(open).toHaveBeenCalledWith('meeting')
    state.change!({ ...stopped, title: 'New title' })
    await Promise.resolve()
    expect(state.notifications).toHaveLength(1)
  })
  it('skips the success banner when the person ended it from the pill, but keeps the in-app notice', async () => {
    send('widget:stop')
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice).toMatchObject({ title: 'Meeting captured', body: 'Review' })
    expect(state.notifications).toHaveLength(0)
  })
  it('skips the success banner when Yogurt was in front, but still warns', async () => {
    vi.resetModules()
    const { createWidget } = await import('../src/main/widget')
    widget = createWidget({ open, stop: vi.fn(), foreground: () => true })
    state.start!({ id: 'meeting', title: 'Review', startedAt: 0 })
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice).toMatchObject({ title: 'Meeting captured' })
    expect(state.notifications).toHaveLength(0)
    state.start!({ id: 'meeting', title: 'Review', startedAt: 0 })
    state.recording!({ t: 'gave-up' })
    finish(); await Promise.resolve()
    expect(state.notifications).toHaveLength(1)
  })
  it('uses the existing save warning and does not notify again when Retry succeeds', async () => {
    state.stopPending = true
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice?.title).toBe('Recording stopped. Open Lynote NoteTaker to finish saving.')
    expect(widget.snapshot().view?.note?.text).toBe('Recording stopped. Open Lynote NoteTaker to finish saving.')
    state.stopPending = false; state.change!(stopped)
    await Promise.resolve()
    expect(state.notifications).toHaveLength(1)
    expect(widget.snapshot().visible).toBe(false)
    expect(widget.snapshot().view?.note).toBeNull()
  })
  it('uses the existing stopped warning after capture gives up, rather than claiming completion', async () => {
    state.recording!({ t: 'gave-up' })
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice?.title).toBe('Recording stopped. Your notes are safe.')
    expect(state.notifications[0].options.title).not.toBe('Meeting captured')
  })
  it('notifies for each explicit recording session, including finishing a paused or resumed note', async () => {
    state.recording!({ t: 'paused', meetingId: 'meeting', paused: true, at: 50 })
    finish(); await Promise.resolve()
    expect(state.notifications).toHaveLength(1)
    state.start!({ id: 'meeting', title: 'Review', startedAt: 0, resume: { startedAt: 200, capturedMs: 50 } })
    finish(); await Promise.resolve()
    expect(state.notifications).toHaveLength(2)
  })
  it.each(['fake', 'background', 'unsupported'] as const)('does not deliver a native notification in %s mode', async (mode) => {
    if (mode === 'background') {
      vi.stubEnv('YOGURT_BACKGROUND', '1'); vi.resetModules()
      const { createWidget } = await import('../src/main/widget')
      widget = createWidget({ open, stop: vi.fn(), foreground: () => false })
      state.start!({ id: 'meeting', title: 'Review', startedAt: 0 })
    } else if (mode === 'fake') state.fake = true
    else state.supported = false
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice).toMatchObject({ title: 'Meeting captured', body: 'Review' })
    expect(state.notifications).toHaveLength(0)
  })
  it('does not notify for startup/recovery changes without a recording started in this run', async () => {
    vi.resetModules()
    const { createWidget } = await import('../src/main/widget')
    widget = createWidget({ open, stop: vi.fn(), foreground: () => false })
    finish(); await Promise.resolve()
    expect(widget.snapshot().notice).toBeNull()
    expect(state.notifications).toHaveLength(0)
  })
})
