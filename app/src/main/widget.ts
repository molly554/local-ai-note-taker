import { BrowserWindow, ipcMain, Notification, screen } from 'electron'
import { join } from 'node:path'
import type { Meeting } from './store'
import { WidgetModel } from './widgetModel'
import { onRecordingEvent, recordingFinished } from './capture'
import { onMeetingChange, onMeetingStart, onMeetingStop, stopSavePending } from './meeting'
import type { WidgetView } from '../shared/types'
import { floatingType, floatOverFullScreen } from './float'
import { isFake } from './paths'
import { t, onLanguage } from '../shared/i18n'
import { widgetLayout, widgetContains, type WidgetSurface, type WidgetLayout } from '../shared/widgetMorph'

const BACKGROUND = process.env.YOGURT_BACKGROUND === '1'
const FIRST_W = 127, FIRST_H = 42

/** Remembered while Yogurt runs, including the next meeting and temporary warning cards. */
let lastWidth = FIRST_W
let lastPosition: { x: number; y: number } | null = null

function fit(bounds: Electron.Rectangle): Electron.Rectangle {
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) })
  return {
    ...bounds,
    x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, Math.round(bounds.x))),
    y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, Math.round(bounds.y))),
  }
}

function createWindow(os = 'darwin'): BrowserWindow {
  // the display the person is working on (the mouse is there), not always the main one
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = fit({ width: lastWidth, height: FIRST_H, ...(lastPosition ?? { x: workArea.x + workArea.width - FIRST_W - 12, y: Math.round(workArea.y + workArea.height * 0.38) }) })
  lastPosition = { x: bounds.x, y: bounds.y }
  const w = new BrowserWindow({
    ...widgetLayout(bounds, screen.getDisplayMatching(bounds).workArea).bounds,
    // One open-sized window avoids native resizing during the morph; transparent space passes clicks through.
    type: floatingType(os, 'panel'),
    // CSS owns the outline; macOS corner clipping cuts through its border.
    frame: false, transparent: true, roundedCorners: false, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, acceptFirstMouse: true, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, backgroundThrottling: false },
  })
  floatOverFullScreen(w)
  w.setIgnoreMouseEvents(true, { forward: true })
  const hash = 'widget'
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  return w
}

/** every window: the pill draws the level, and the note's recording bar does too */
const broadcast = (channel: string, v: unknown) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, v) }

/**
 * The recording-only pill grows into its transcript and warning. Finished
 * meetings use a native notification; paused meetings keep no floating surface.
 */
export function createWidget(d: { open(meetingId: string): void; stop(meetingId: string): void; foreground(): boolean; os?: string
  /** the computer the windows are made for (a Mac's panel, a tool window elsewhere) */
  windowOs?: string }) {
  const model = new WidgetModel(d.os)
  let win: BrowserWindow | undefined
  let pill = { x: 0, y: 0, width: FIRST_W, height: FIRST_H }
  let layout: WidgetLayout | null = null
  let dragFrame: { layout: WidgetLayout; pill: typeof pill } | null = null
  let surface: WidgetSurface | null = null
  let pressed = false, ignoring = true, sentPointer: string | null = null
  let pointerTimer: NodeJS.Timeout | undefined
  let sized = false
  let dragPosition: { x: number; y: number } | null = null
  let noteTimer: NodeJS.Timeout | undefined
  let notifyOnChange = false
  /** the person just ended it (the app was in front, or they pressed the pill), so a success banner would only repeat it */
  let stoppedHere = false, stopPressed = false
  let notice: { title: string; body: string; meetingId: string } | null = null
  let notification: Notification | undefined
  /** what a test can see: the window itself is hidden in tests */
  let shown = false

  const hitTest = () => {
    if (!win || win.isDestroyed()) return false
    const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds()
    const x = cursor.x - bounds.x, y = cursor.y - bounds.y
    const ignore = !shown || (!pressed && (!surface || !widgetContains(surface, x, y)))
    if (ignore !== ignoring) { ignoring = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }) }
    // Only a pointer over the window matters; a still or distant pointer sends nothing.
    const over = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height, key = over ? `${x},${y}` : ''
    if (!BACKGROUND && key !== sentPointer) { sentPointer = key; win.webContents.send('widget:pointer', over ? { x, y } : { x: -1, y: -1 }) }
    return over
  }
  // Frame-rate checks only while the pointer is over the window; elsewhere a slow check, and none while hidden.
  // The renderer's own mouse events (forwarded through the click-through area) speed it up at once.
  const poll = () => {
    clearTimeout(pointerTimer)
    if (!shown || BACKGROUND || !win || win.isDestroyed()) return
    pointerTimer = setTimeout(poll, hitTest() || pressed ? 16 : 250)
  }
  const place = () => {
    if (!win || win.isDestroyed()) return
    layout = widgetLayout(pill, screen.getDisplayMatching(pill).workArea)
    win.setBounds(layout.bounds)
    win.webContents.send('widget:layout', layout)
    hitTest()
  }

  const visibilityChanged = () => {
    const view = model.view(Date.now())
    shown = view?.kind === 'recording' && !view.paused && !d.foreground()
    if (!shown) { clearTimeout(pointerTimer); pressed = false; win?.webContents.send('widget:reset') }
    hitTest(); poll()
    if (!win || win.isDestroyed() || BACKGROUND) return
    if (!shown) win.hide()
    else if (sized && !win.isVisible()) win.showInactive()
  }

  const push = () => { broadcast('widget:state', model.view(Date.now())); visibilityChanged() }
  // its hints are written here, so a new interface language sends them again
  onLanguage(() => { if (win && !win.isDestroyed()) push() })
  const close = () => {
    clearTimeout(noteTimer)
    shown = false; sized = false; dragPosition = null; dragFrame = null
    clearTimeout(pointerTimer); surface = null; pressed = false
    screen.removeListener('display-added', displayChanged)
    screen.removeListener('display-removed', displayChanged)
    screen.removeListener('display-metrics-changed', displayChanged)
    if (win && !win.isDestroyed()) win.destroy()
    win = undefined
  }
  const open = () => {
    if (win && !win.isDestroyed()) return
    screen.on('display-added', displayChanged)
    screen.on('display-removed', displayChanged)
    screen.on('display-metrics-changed', displayChanged)
    win = createWindow(d.windowOs); sized = false; ignoring = true; sentPointer = null
    pill = { ...lastPosition!, width: lastWidth, height: FIRST_H }
    layout = widgetLayout(pill, screen.getDisplayMatching(pill).workArea)
    win.on('closed', () => { clearTimeout(pointerTimer); win = undefined })
  }

  onMeetingStart((m) => {
    notifyOnChange = false; notice = null; stopPressed = false
    model.start({ id: m.id, title: m.title, startedAt: m.resume ? m.resume.startedAt - m.resume.capturedMs : m.startedAt })
    open(); push()
  })
  onMeetingStop((m: Meeting) => {
    if (model.meetingId !== m.id || model.view(Date.now())?.kind !== 'recording') return
    // The following change event reports whether the stopped metadata was saved.
    model.stop(Date.now())
    notifyOnChange = true
    stoppedHere = stopPressed || d.foreground(); stopPressed = false
    close(); push()
  })
  // renamed in the note while it records
  onMeetingChange((m: Meeting) => {
    if (model.meetingId !== m.id) return
    model.retitle(m.title)
    model.stopSavePending(stopSavePending(m.id))
    const view = model.view(Date.now())
    if (notifyOnChange && view?.kind === 'captured') {
      notifyOnChange = false
      const completed = { title: view.note?.text ?? (view.crashed ? t('Recording stopped. Your notes are safe.') : t('Meeting captured')), body: m.title, meetingId: m.id }
      const quiet = stoppedHere && !view.note && !view.crashed
      void recordingFinished(m.id).then(() => {
        // The call-ended prompt already owns its native notification.
        if (view.callEnded) return
        notice = completed
        if (quiet || BACKGROUND || isFake() || !Notification.isSupported()) return
        notification?.close()
        notification = new Notification({ title: completed.title, body: completed.body, silent: true })
        notification.on('click', () => d.open(completed.meetingId))
        notification.show()
      }).catch((error) => console.error('could not notify after recording', error))
    }
    push()
  })
  onRecordingEvent((e) => {
    if (!model.meetingId) return
    if (e.t === 'level') broadcast('widget:level', { me: e.me, them: e.them })
    else if (e.t === 'paused' && e.meetingId === model.meetingId) { model.pause(e.paused, e.at); push() }
    else if (e.t === 'warn') { model.warn(e.code); push() }
    else if (e.t === 'gave-up') model.gaveUp()
    else if (e.t === 'hiccup') {
      model.hiccup(Date.now()); push()
      // the hiccup note leaves by itself
      clearTimeout(noteTimer)
      noteTimer = setTimeout(push, 4100)
    }
  })

  ipcMain.handle('widget:state', () => model.view(Date.now()))
  ipcMain.on('widget:open', () => {
    const id = model.meetingId
    if (!id) return
    shown = false
    clearTimeout(pointerTimer); pressed = false
    if (win && !win.isDestroyed()) { win.webContents.send('widget:reset'); hitTest(); win.hide() }
    d.open(id)
  })
  ipcMain.on('widget:stop', () => { const id = model.meetingId; if (id && model.view(Date.now())?.kind === 'recording') { stopPressed = true; d.stop(id) } })
  ipcMain.handle('widget:layout', () => win && !win.isDestroyed() ? layout : null)
  ipcMain.on('widget:surface', (e, value: unknown) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !value || typeof value !== 'object') return
    const r = value as WidgetSurface
    if (![r.x, r.y, r.width, r.height, r.radius].every(n => typeof n === 'number' && Number.isFinite(n)) || r.width <= 0 || r.height <= 0 || r.width > 600 || r.height > 600 || r.radius < 0 || r.radius > 100 || Math.abs(r.x) > 600 || Math.abs(r.y) > 600) return
    surface = r; poll()
    // The renderer has painted its first surface before the native window appears.
    if (!sized) { sized = true; visibilityChanged() }
  })
  ipcMain.on('widget:pressed', (e, value: unknown) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || typeof value !== 'boolean') return
    pressed = value; poll()
  })
  ipcMain.on('widget:drag', (e, dx: unknown, dy: unknown) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return
    const from = dragPosition ?? pill
    const x = from.x + dx, y = from.y + dy
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    // Keep the unclamped gesture position so small deltas can cross a display boundary.
    dragPosition = { x, y }
    if (!layout) return
    dragFrame ??= { layout, pill: { ...pill } }
    pill = fit({ ...pill, x, y })
    const frame = dragFrame.layout
    if (surface && surface.height > FIRST_H + 1) {
      const area = screen.getDisplayMatching(pill).workArea
      if (frame.open.width > area.width || frame.open.height > area.height) {
        place(); dragFrame = null; return
      }
      // Keep the frozen surface and its remaining travel on the destination display.
      const left = Math.min(surface.x, frame.open.x) - frame.pill.x
      const top = Math.min(surface.y, frame.open.y) - frame.pill.y
      const right = Math.max(surface.x + surface.width, frame.open.x + frame.open.width) - frame.pill.x
      const bottom = Math.max(surface.y + surface.height, frame.open.y + frame.open.height) - frame.pill.y
      pill.x = Math.max(area.x - left, Math.min(area.x + area.width - right, pill.x))
      pill.y = Math.max(area.y - top, Math.min(area.y + area.height - bottom, pill.y))
    }
    layout = { ...frame, bounds: { ...frame.bounds, x: frame.bounds.x + pill.x - dragFrame.pill.x, y: frame.bounds.y + pill.y - dragFrame.pill.y } }
    win.setBounds(layout.bounds); hitTest()
  })
  ipcMain.on('widget:drag-end', (e) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    if (dragPosition) lastPosition = { x: pill.x, y: pill.y }
    dragPosition = null; dragFrame = null
    if (!surface || surface.height <= FIRST_H + 1) place()
  })
  ipcMain.on('widget:size', (e, w: unknown, h: unknown) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || typeof w !== 'number' || !Number.isFinite(w) || w < 60 || w > 340 || h !== FIRST_H || pressed) return
    // rounded, not up: the timer is a fractional width, and rounding up left the right end a pixel wider than the left
    const width = Math.round(w)
    if (width === pill.width) return
    lastWidth = width
    pill = fit({ ...pill, x: pill.x + pill.width - width, width })
    lastPosition = { x: pill.x, y: pill.y }; place()
  })
  const displayChanged = () => {
    if (!win || win.isDestroyed()) return
    pill = fit(pill); lastPosition = { x: pill.x, y: pill.y }; place()
  }

  return {
    visibilityChanged,
    elapsed: () => model.view(Date.now())?.elapsedMs ?? 0,
    /** the recording is about to stop because its call ended: the finished card says so */
    callEnded: (meetingId: string) => { if (model.meetingId === meetingId) model.callEnded() },
    /** The same actual transcript events used by the main note, delivered to the recorder. */
    transcript: (channel: string, value: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, value) },
    /** for tests: what the widget would show, and where it sits */
    snapshot: (): { visible: boolean; view: WidgetView | null; notice: typeof notice; bounds: Electron.Rectangle | null; workArea: Electron.Rectangle } =>
      ({ visible: shown, view: model.view(Date.now()), notice, bounds: win && !win.isDestroyed() ? { ...pill } : null, workArea: (win && !win.isDestroyed() ? screen.getDisplayMatching(pill) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea }),
  }
}
