import { resolvePeople } from './people'
import { createFolderSuggestions } from './folderSuggestions'
import { speakerColor } from '../shared/speakerColors'
import { createNotificationPermission } from './notificationPermission'
import { createRecordingReminder } from './recordingReminder'
import { closeAction, keepMainWindow } from './mainWindow'
import { titleBarOverlay, windowChrome } from './windowChrome'
import { x11Relaunch } from './display'
import { isAppRoute } from '../shared/routes'
import { relaunchOptions } from './relaunch'
import { capabilities, micListHelper, platformOf, supportedKinds } from '../shared/platform'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, protocol, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isFake, userDataDir } from './paths'
import { logToFile } from './log'
import { cloudSetting, loadSettings, localeOf, notesLanguageSetting, recordingReminderOn, spokenSetting, stopsWhenCallEnds, updateSettings } from './settings'
import { CALL_GONE_MS, useCallApps } from './detect'
import { systemLocale } from './locale'
import { PRODUCT } from '../shared/brand'
import { onLanguage, setLanguage, t } from '../shared/i18n'
import bundledCatalog from '../../../catalog/catalog.json'
import licenses from '../../../catalog/licenses.json'
import { loadCatalog } from './catalog'
import { readSysInfo, toHardware, type GpuProbe } from './hardware'
import { realDeps } from './downloader'
import { wavOf } from './fakeCapture'
import { askFakeNotifications, chatMeetings, fakeAccess, fakeDownloadDeps, fakeHardware, fakeHelper, fakeNow, installFakeHooks, manyMeetings, mediaCalls, waitForFakeAudioMetadata } from './fake'
import { createPermissions } from './permissions'
import { hookPreferences } from './preferences'
import { loginItemOn, openedAtLogin, setLoginItem, syncLoginItem } from './loginItem'
import { createMedia } from './media'
import { createTray, linuxTrayHost } from './tray'
import { SetupController } from './setup'
import { fakeMeasure, measureSpeed, speedClipPath, speedStore } from './asr/speedCheck'
import { vadModelPath, whisperServerPath } from './asr/server'
import { openStore, type Store } from './store'
import { calendars, eventIds, matchesEvent, setCalendarSelection, calendarStatus, createHelperRunner, helperPath, killAllHelpers, refreshCalendarStatus, requestCalendarAccess, runHelper, setCalendarSupported, setHelper, upcoming, type CalEvent } from './calendar'
import { createSignals } from './detectSignals'
import { Watcher } from './watch'
import { createPrompts } from './prompts'
import { activeMeeting, bindMeetingApp, getMeeting, initMeetings, onMeetingChange, onMeetingStart, onMeetingStop, onMeetingStopSaved, linkEvent, unlinkEvent, prepareMeeting, startPreparedMeeting, resumeMeeting, pauseMeetingClock, renameMeeting, retryStopSave, setAttendees, startMeeting, stopMeeting, stopSavePending, withStopState } from './meeting'
import { deleteMeeting } from './deleteMeeting'
import { emptyTrash, moveToTrash, purgeTrash } from './trash'
import { isId, text } from './ipcArgs'
import { hookMics } from './mics'
import { activeCapture, audioHelperPath, hookCapture, joinParts, onCaptureStart, onRecordingEvent, prepareAppend, recordingFinished, recordingPaused, recordingSettled, rejoinInterrupted, setRecordingPaused, settleRecording, tell, type WarnCode } from './capture'
import { createWidget } from './widget'
import { hookTranscription, onWhisperGpuOff, meetingLanguage, settleTranscription, speechLocaleFor, spokenChanged, transcriptionBacklogMs, stopTranscriptionServer, transcriptFinished, transcriptPartials } from './asr'
import { hookCallNames, type Watch } from './callNames'
import { helperWatch, killAllWatches } from './callNames/watch'
import { macFullName } from './user'
import { setJargon, setOwnerName } from './vocab'
import { cleanJargon } from '../shared/jargon'
import { setGenericTitles } from './titles'
import { installAppMenu } from './appMenu'
import { UtilityEngine } from './engine'
import { createNotesModel } from './notes/model'
import { withCloud } from './notes/cloud'
import { open as openSecret, seal as sealSecret } from './secret'
import { FakeEngine } from './notes/fake'
import { hookNotes } from './notes'
import { hookReadAhead, readAheadAllowed } from './notes/readAhead'
import { createQueue, isSmallMac } from './notes/queue'
import type { ContextChip } from '../shared/askContext'
import { Library } from './library/store'
import { createEmbedder } from './library/embedder'
import { createIndexer } from './library/indexer'
import { hookConversations } from './library/conversations'
import { hookShare } from './share'
import { hookBackup } from './backupIpc'
import { hookFolders } from './foldersIpc'
import { hookMcp } from './mcp'
import { startedHidden } from './mcp/paths'
import { AUDIO_SCHEME, audioExts, createAudioHandler, trackFile, type AudioExt } from './audio'
import { finishQuit, hookUpdates, isPreviewBuild, updatesOn } from './updates'
import { offerInstallerEject } from './installer'
import type { NoteSaveResult, StartResult } from '../shared/types'

// the transcript's player streams each meeting's audio from here; seeking needs stream support (before ready)
protocol.registerSchemesAsPrivileged([{ scheme: AUDIO_SCHEME, privileges: { standard: true, secure: true, stream: true } }])

app.setName(PRODUCT)
// Windows shows notifications only for an app with this id (the installer's shortcut carries the same one, electron-builder appId)
if (process.platform === 'win32') app.setAppUserModelId('so.yogurt.app')
app.setPath('userData', userDataDir())
mkdirSync(userDataDir(), { recursive: true })
logToFile(join(userDataDir(), 'logs', 'main.log'))
// logged, never a dialog: one bad message or a failed promise must not stop a recording
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err))
process.on('uncaughtException', (err) => console.error('uncaught exception', err))

// Linux on Wayland: once more through XWayland, so the widget and the card can float (display.ts)
const x11 = x11Relaunch(process.platform, process.argv, process.env, process.execPath)
if (x11) { app.relaunch(x11); app.exit(0) }
// One Yogurt at a time: a second launch focuses the existing window
else if (!app.requestSingleInstanceLock()) app.quit()
let win: BrowserWindow | undefined
let allowQuit = false
let presentMain = (_foreground = false) => {}
let updateMainMenu = () => {}
let setTrayVisible = (_on: boolean) => {}
/** whether the tray icon is there to reopen Yogurt from (Windows and Linux minimise on close without it) */
let trayShown = () => true
/** test runs: no window on screen, never takes focus from what the person is doing */
const BACKGROUND = process.env.YOGURT_BACKGROUND === '1'
// an AI app's yogurt-mcp starting Yogurt while it was still opening (--hidden) brings no window forward
app.on('second-instance', (_e, argv) => { if (app.isReady() && !startedHidden(process.platform, argv)) showMain() })

/** Links open in the user's browser, never inside the app window. */
function openExternally(url: string) {
  if (!isFake() && /^https:\/\//.test(url)) void shell.openExternal(url)
}

let updateWidgetVisibility = () => {}
let sendWidgetTranscript = (_channel: string, _value: unknown) => {}
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 720, minHeight: 520,
    title: PRODUCT,
    ...windowChrome(process.platform, nativeTheme.shouldUseDarkColors),
    show: false,
    // hidden pages would otherwise pause timers and animations
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, ...(BACKGROUND ? { backgroundThrottling: false } : {}) },
  })
  presentMain = keepMainWindow(win, { background: BACKGROUND, canClose: () => allowQuit, activate: () => app.focus({ steal: true }),
    closeTo: () => closeAction(process.platform, trayShown()), glass: process.platform === 'darwin', lift: process.platform === 'darwin' })
  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false)
    // the window buttons follow light and dark mode
    const recolor = () => { if (win && !win.isDestroyed()) { win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors)); win.setBackgroundColor(titleBarOverlay(nativeTheme.shouldUseDarkColors).color) } }
    nativeTheme.on('updated', recolor)
    win.on('closed', () => nativeTheme.off('updated', recolor))
  }
  win.webContents.setWindowOpenHandler(({ url }) => { openExternally(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    const ownPage = process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url === pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    if (ownPage) return
    e.preventDefault()
    openExternally(url)
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  const visibilityChanged = () => { updateWidgetVisibility(); updateMainMenu() }
  win.on('focus', visibilityChanged)
  win.on('blur', visibilityChanged)
  win.on('show', visibilityChanged)
  win.on('hide', visibilityChanged)
  win.on('minimize', visibilityChanged)
  win.on('restore', visibilityChanged)
  win.on('closed', () => { win = undefined; visibilityChanged() })
  // a page still loading misses a go-to sent to it: tell it again once it is up
  win.webContents.on('did-finish-load', () => { if (route) win?.webContents.send('nav:go', route) })
  presentMain()
}

/** First-run downloads: speech, speaker and notes models. Fake mode swaps in instant downloads and a fixed Mac. */
/** Windows and Linux: what graphics the notes engine can use; null when it can't tell (or crashed checking: it then runs without them) */
let probeGpu: () => Promise<GpuProbe | null> = async () => null
function createSetup(): SetupController {
  const modelsDir = join(userDataDir(), 'models')
  return new SetupController({
    modelsDir,
    // Windows and Linux: the notes engine checks the graphics first (a Mac shares its memory with them, no check)
    getHardware: isFake() ? () => fakeHardware(platform) : async () => toHardware(await readSysInfo(userDataDir()), process.platform === 'darwin' ? undefined : await probeGpu()),
    // the one in this build: new models come with app updates
    getCatalog: async () => loadCatalog({ bundled: bundledCatalog, licenses }),
    download: isFake() ? fakeDownloadDeps({ stepMs: Number(process.env.YOGURT_FAKE_STEP_MS ?? 5), notesMs: Number(process.env.YOGURT_FAKE_NOTES_MODEL_MS ?? 0) }) : realDeps,
    ...(isFake() ? { sha256Override: 'FAKE' } : {}),
    // Windows and Linux: speech models timed on this computer (asr/speedCheck.ts); a Mac never is
    ...(platform === 'darwin' ? {} : { speed: { ...speedStore(speedFile()), measure: isFake() ? fakeMeasure() : (model: string) => measureSpeed(model, { binary: whisperServerPath(), vadModel: vadModelPath(), clip: speedClipPath() ?? '' }) } }),
  })
}
/** what the speed check found (Windows and Linux) */
const speedFile = () => join(userDataDir(), 'speech-speed.json')

/** What this computer can do (fake mode can pretend with YOGURT_FAKE_PLATFORM): Windows and Linux have no calendar or names from calls yet */
const platform = platformOf(process.platform, process.env)
const caps = capabilities(platform)
setCalendarSupported(caps.calendar)
// the call apps yogurt-system names on this computer (fake mode's helper speaks in a Mac's ids)
useCallApps(isFake() ? 'darwin' : process.platform)
/** Windows and Linux: the recorder lists the mics itself (yogurt-audio mic-devices) */
const audioHelper = createHelperRunner(audioHelperPath)
/** Windows: the recorder said the mic is blocked (Privacy & security), until a recording hears it again */
let micBlocked = false
onCaptureStart(() => { micBlocked = false })
onRecordingEvent((e) => { if (e.t === 'warn' && e.code === 'no-mic') micBlocked = true })

/**
 * Microphone, call audio, calendar and Accessibility (names from calls) through the Mac helper.
 * Notifications remember a confirmed post for this bundle and signer, never authorization.
 */
const notificationPermission = createNotificationPermission(join(userDataDir(), 'settings.json'))
const permissions = createPermissions({
  helper: (a) => runHelper(a),
  // Requested before is not proof that permission was granted.
  notifications: () => isFake() ? fakeAccess.notifications : notificationPermission.status(),
  askNotifications: async () => isFake() ? askFakeNotifications() : notificationPermission.request(),
  open: (url) => { if (isFake()) systemSettings.push(url); else void shell.openExternal(url) },
  axAsked: () => !!loadSettings(join(userDataDir(), 'settings.json')).axAsked,
  setAxAsked: () => updateSettings(join(userDataDir(), 'settings.json'), { axAsked: true }),
  platform, micBlocked: () => micBlocked,
})

/** Reuse the hidden main window, including its route, scroll, drafts and position. */
function showMain() {
  if (!win) { createWindow(); presented++ }
  presentMain(true)
}

/** Where the app was last told to go (e.g. /note/<id>); the window asks for it when it opens */
let route = ''
let pendingAsk = false
function askFromMenu() {
  pendingAsk = true
  showMain()
  win?.webContents.send('nav:ask')
}
function goTo(next: string) {
  route = next
  if (!win) createWindow()
  win?.webContents.send('nav:go', route)
  presented++
  // The card and widget never take focus, so their explicit navigation brings Yogurt forward.
  presentMain(true)
}
/** how many times the window was asked to come forward (tests run it hidden, so they check this) */
let presented = 0
/** fake mode: how many times the Mac's Calendar settings would have opened */
let settingsOpened = 0
let refreshCalendarConsumers = () => {}
/** fake mode: the System Settings panes the permission steps and Settings would have opened */
const systemSettings: string[] = []
/** fake mode: how many times Yogurt would have quit and opened again for a permission */
let relaunched = 0

/** What is still to come today and tomorrow (meetings on now included), soonest first */
async function comingUp(): Promise<CalEvent[]> {
  const now = isFake() ? fakeNow() : Date.now()
  const end = new Date(now); end.setDate(end.getDate() + 2); end.setHours(0, 0, 0, 0)
  return (await upcoming(now, end.getTime())).filter((e) => e.end > now && e.start < end.getTime()).sort((a, b) => a.start - b.start)
}

/** The events on the day of this time, earliest first */
async function eventsOn(at: number): Promise<CalEvent[]> {
  const from = new Date(at); from.setHours(0, 0, 0, 0)
  const to = new Date(from); to.setDate(to.getDate() + 1)
  return (await upcoming(from.getTime(), to.getTime())).sort((a, b) => a.start - b.start)
}

/** the Mac's full name: who "You" is unless Settings says otherwise (fake mode: a fixed one) */
/** fake mode's call (callNames/fake.ts), loaded only in fake mode */
const fakeCallWatch: Watch = (ids, onLine) => {
  let inner: { stop(): void } | undefined, stopped = false
  void import('./callNames/fake').then((m) => { if (!stopped) inner = m.fakeWatch()(ids, onLine) })
  return { stop: () => { stopped = true; inner?.stop() } }
}
const macName = () => (isFake() ? process.env.YOGURT_FAKE_FULL_NAME ?? 'Sam Rivera' : macFullName())

/** fake mode's hooks reach the store and the notes through these */
let storeRef: Store | undefined
let indexerRef: { schedule(): Promise<unknown> } | undefined

/** Notice calls, offer to take notes, stop when the call ends (or ask, with that setting off). Starts nothing without a click. */
function startDetection() {
  if (isFake()) setHelper(fakeHelper)
  const signals = createSignals({ helper: runHelper, events: upcoming })
  refreshCalendarConsumers = () => signals.invalidateCalendar()
  const now = isFake() ? fakeNow : Date.now
  const watcher: Watcher = new Watcher({
    read: (at) => signals.read(at), now, active: activeMeeting, bindApp: bindMeetingApp,
    offer: (p) => prompts.offer(p), askStop: (m) => prompts.askStop(m), hide: () => prompts.hide(),
    // the call ended: the same stop as the widget's Stop button, then say so
    autoStop: (m) => { widget.callEnded(m.id); stopMeeting(m.id); prompts.stopped(m) },
    autoStopOn: () => stopsWhenCallEnds(loadSettings(join(userDataDir(), 'settings.json'))),
    // fake mode: tests can shorten the grace
    graceMs: isFake() && process.env.YOGURT_FAKE_CALL_GONE_MS ? Number(process.env.YOGURT_FAKE_CALL_GONE_MS) : CALL_GONE_MS,
  })
  onMeetingStop(() => watcher.cleared())
  const prompts = createPrompts({
    windowVisible: () => !!win && win.isVisible() && !win.isMinimized(),
    takeNotes: (p) => begin({ title: p.title || t('{app} call', { app: p.app ?? '' }).trim(), event: p.event, app: p.app }),
    stop: (id) => { stopMeeting(id) },
    dismissed: (key) => watcher.dismiss(key),
    keepGoing: () => watcher.keepGoing(),
    open: (id) => goTo(`/note/${id}`),
    os: process.platform,
  })
  const widget = createWidget({
    os: platform, windowOs: process.platform,
    open: (id) => goTo(`/note/${id}`),
    stop: (id) => { stopMeeting(id) },
    foreground: () => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused(),
  })
  onMeetingStart(() => { prompts.hide(); watcher.cleared() })
  // Recording needs the mic and the call audio: one never asked is asked now (the Mac's own prompt, as any app does
  // when it first records); one still off says so under the note, where its button turns it on.
  onMeetingStart((m) => void (async () => {
    // Windows and Linux have no prompts: the recorder itself says when the mic is blocked
    if (!caps.permissionPrompts) return
    for (const [kind, code] of [['mic', 'no-mic'], ['systemAudio', 'no-system-audio']] as const) {
      let access = (await permissions.status())[kind]
      if (access === 'unknown') access = await permissions.request(kind)
      if (access !== 'granted' && activeMeeting()?.id === m.id) tell({ t: 'warn', code })
    }
  })().catch((e) => console.warn("couldn't check what recording needs", e)))
  updateWidgetVisibility = widget.visibilityChanged
  sendWidgetTranscript = widget.transcript
  /** The one way notes start: the card's Take notes, and home's Start notes and New note. Opens the note. */
  function begin(p: { title: string; event: CalEvent | null; app: string | null }) {
    const m = startMeeting(p)
    prompts.hide(); watcher.cleared(); goTo(`/note/${m.id}`)
    return m.id
  }
  // home: Start notes for a calendar event (looked up here, never taken from the page), or New note with none
  // gone: the event left the calendar since the page showed it (moved, cancelled); failed: anything else, in plain words on the page
  ipcMain.handle('meetings:start', async (_e, eventId: unknown): Promise<StartResult> => {
    try {
      const cur = activeMeeting()
      if (cur) { goTo(`/note/${cur.id}`); return { id: cur.id, alreadyRecording: true } }
      let event: CalEvent | null = null
      if (typeof eventId === 'string') {
        event = (await comingUp()).find((e) => matchesEvent(e, eventId)) ?? null
        if (!event) return { error: 'gone' }
      }
      return { id: begin({ title: event?.title ?? '', event, app: null }) }
    } catch (e) {
      console.error('start notes failed', e)
      return { error: 'failed' }
    }
  })
  ipcMain.handle('meetings:prepare', async (_e, eventId: unknown, at: unknown): Promise<StartResult> => {
    if (typeof eventId !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return { error: 'gone' }
    try {
      const event = (await eventsOn(at)).find((e) => matchesEvent(e, eventId))
      if (!event) return { error: 'gone' }
      const m = prepareMeeting(event)
      goTo(`/note/${m.id}`)
      return { id: m.id }
    } catch (e) {
      console.error('prepare notes failed', e)
      return { error: 'failed' }
    }
  })
  ipcMain.handle('meetings:start-prepared', (_e, id: unknown): StartResult => {
    if (!isId(id)) return { error: 'gone' }
    try {
      const m = startPreparedMeeting(id)
      if (!m) return { error: 'gone' }
      prompts.hide(); watcher.cleared(); goTo(`/note/${m.id}`)
      return { id: m.id }
    } catch (e) {
      console.error('start prepared notes failed', e)
      return { error: 'failed' }
    }
  })
  // the note's own Stop button: the same stop as the widget and the menu bar
  ipcMain.on('meetings:stop', (_e, id: unknown) => { if (isId(id) && activeMeeting()?.id === id) stopMeeting(id) })
  const pauseRecording = (id: unknown, paused: unknown) => {
    if (!isId(id) || typeof paused !== 'boolean' || activeMeeting()?.id !== id) return false
    const changed = setRecordingPaused(id, paused)
    if (changed) { pauseMeetingClock(id, paused); win?.webContents.send('meetings:changed') }
    return changed
  }
  ipcMain.handle('meetings:set-paused', (_e, id: unknown, paused: unknown) => pauseRecording(id, paused))
  ipcMain.handle('meetings:retry-stop-save', (_e, id: unknown) => isId(id) && retryStopSave(id))
  // the menu bar: open, new note or stop, quit; Yogurt stays there with its window closed
  const tray = createTray({
    show: !BACKGROUND, visible: loadSettings(join(userDataDir(), 'settings.json')).showInMenuBar !== false,
    open: () => { presented++; showMain() },
    newNote: () => { if (!activeMeeting()) begin({ title: '', event: null, app: null }) },
    stop: (id) => { stopMeeting(id) },
    pause: pauseRecording,
    ask: askFromMenu, settings: () => goTo('/settings'),
    openNote: (id) => { const note = storeRef?.meeting(id); if (note && note.trashedAt == null) goTo(`/note/${id}`) },
    recent: () => storeRef?.meetingCards({ limit: 5 }) ?? [],
    events: comingUp, now,
    elapsed: widget.elapsed,
    os: platform,
    host: process.platform === 'linux' && !BACKGROUND ? linuxTrayHost : undefined,
    event: async (event, join) => {
      const current = (await comingUp()).find(e => matchesEvent(e, event.id))
      if (!current) return
      if (join) {
        if (activeMeeting() || !current.url?.trim()) return
        begin({ title: current.title, event: current, app: null })
        openExternally(current.url.trim())
      } else { const note = prepareMeeting(current); goTo(`/note/${note.id}`) }
    },
  })
  refreshCalendarConsumers = () => { signals.invalidateCalendar(); void tray.refreshCalendar() }
  setTrayVisible = tray.setVisible
  trayShown = tray.shown
  // cheap, and only while Yogurt runs
  const timer = setInterval(() => void watcher.tick().catch((e) => console.error('detect failed', e)), 3000)
  app.on('will-quit', () => clearInterval(timer))
  if (isFake()) {
    installFakeHooks({
      signals: async (r) => { signals.override(r); await watcher.tick() },
      advance: () => watcher.tick(),
      widget: () => widget.snapshot(),
      main: () => ({ presented, visible: !!win?.isVisible(), route, settingsOpened, systemSettings, mediaCalls, relaunched }),
      go: (r) => goTo(r),
      warn: (code) => tell({ t: 'warn', code: code as WarnCode }),
      // a long finished meeting: n lines half a second apart, voices taking turns, with quiet low-rate audio to play
      bigMeeting: (n) => {
        const store = storeRef!
        const startedAt = Date.now() - n * 500
        const m = store.createMeeting({ title: 'Long meeting', startedAt, endedAt: startedAt + n * 500, eventId: null, app: null, attendees: [], state: 'done' })
        store.addSegments(Array.from({ length: n }, (_, i) => {
          const track = i % 7 < 3 ? 'me' as const : 'them' as const
          return { meetingId: m.id, track, startMs: i * 500, endMs: i * 500 + 400, text: `Line ${i + 1} of the long meeting.`, speaker: track === 'them' ? (i % 14 < 7 ? 'Ann Lee' : 'Bo Park') : 'me' }
        }))
        const dir = join(userDataDir(), 'meetings', m.id)
        mkdirSync(dir, { recursive: true })
        for (const t of ['me', 'them']) writeFileSync(join(dir, `${t}.wav`), wavOf([new Float32Array(Math.ceil(n * 0.5 * 4000))], 4000))
        return m.id
      },
      manyMeetings: (o) => (typeof o === 'number' ? manyMeetings(storeRef!, o) : manyMeetings(storeRef!, o.n, o.clean)),
      calendarChanged: refreshCalendarConsumers,
      tray: () => tray.items(),
      trayClick: (id) => tray.click(id as Parameters<typeof tray.click>[0]),
      trayAccelerators: () => tray.accelerators(),
      permissions: () => permissions.status(),
      notice: () => prompts.notice(),
      noticeClick: () => prompts.clickNotice(),
      chatMeetings: async () => { const ids = chatMeetings(storeRef!); await indexerRef?.schedule(); return ids },
      crashCapture: () => { (activeCapture() as unknown as { proc: { kill(s: NodeJS.Signals): boolean } } | null)?.proc.kill('SIGKILL') },
    })
  }
}

app.whenReady().then(() => {
  // Local Electron launches need the same Dock icon as the packaged application.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  const settings = loadSettings(join(userDataDir(), 'settings.json'))
  // the theme picked in Settings; the system's when none
  nativeTheme.themeSource = settings.theme ?? 'system'
  setLanguage(localeOf(settings, systemLocale()))
  updateMainMenu = installAppMenu(() => win, showMain, process.platform)
  // the interface language's generic titles, so one Yogurt gave in that language is known as generic
  const generic = () => setGenericTitles({ meeting: t('Meeting'), appCall: t('{app} call', { app: '\u0000' }) })
  generic()
  onLanguage(generic)
  if (isFake()) setHelper(fakeHelper)
  // a moved or reinstalled Yogurt loses its login item: put it back if the person wanted it
  if (!isFake()) syncLoginItem(settings.openAtLogin)
  hookPreferences({
    seal: sealSecret,
    file: join(userDataDir(), 'settings.json'), permissions, kinds: supportedKinds(caps),
    // fake mode asks the first-run questions only when a test sets the permissions
    ask: !isFake() || !!process.env.YOGURT_FAKE_PERMISSIONS,
    setLogin: (on) => { if (!isFake()) setLoginItem(on) },
    setTrayVisible: (on) => setTrayVisible(on),
    loginOn: (saved) => (isFake() ? !!saved : loginItemOn(saved)),
    macName,
    // never mid-meeting: quitting would end the recording
    relaunch: () => {
      if (activeMeeting()) return false
      if (isFake()) { relaunched++; return true }
      app.relaunch(relaunchOptions(process.platform, app.isPackaged, process.execPath, process.env.APPIMAGE)); app.quit()
      return true
    },
    slowStartMs: isFake() ? Number(process.env.YOGURT_FAKE_BOOT_MS ?? 0) : 0,
    onSpoken: () => spokenChanged(),
  })
  // Music and Spotify pause while a meeting records, and play again after
  const media = createMedia({ helper: runHelper })
  // Windows and Linux: no player is paused yet (capabilities.mediaPause); resume() then has nothing to do
  if (caps.mediaPause) {
    onMeetingStart(() => void media.pause())
    onMeetingStop(() => void media.resume())
  }
  const setup = createSetup()
  setup.onState((st) => win?.webContents.send('setup:state', st))
  ipcMain.handle('setup:state', () => setup.state)
  ipcMain.handle('setup:retry', () => setup.retry())
  const store = openStore(join(userDataDir(), 'yogurt.db'))
  storeRef = store
  store.markInterrupted()
  initMeetings(store)
  // the person's own names, never given to the other side: the one in Settings and the Mac's
  const settingsFile = join(userDataDir(), 'settings.json')
  setCalendarSelection(() => loadSettings(settingsFile).hiddenCalendarIds ?? [])
  const me = () => loadSettings(settingsFile).myName?.trim() || macName()
  setOwnerName(me)
  setJargon(() => cleanJargon(loadSettings(settingsFile).jargon))
  // names from the call: the call app is read while a meeting records, and each line of the other side gets the name talking then
  const callNames = hookCallNames({
    store, watch: !caps.callNames ? () => ({ stop() {} }) : isFake() ? fakeCallWatch : helperWatch(helperPath), myNames: () => [me(), macName()],
    transcribed: async (id) => { await recordingFinished(id); await transcriptFinished(id) },
    // people seen in the call joined the meeting: unedited notes already written get written again for them
    changed: (id) => { win?.webContents.send('transcript:speakers', id); sendWidgetTranscript('transcript:speakers', id); win?.webContents.send('meetings:changed'); notes.applyPeople(id) },
    onStart: onMeetingStart, onStop: onMeetingStop, onCapture: onCaptureStart,
  })
  // Windows and Linux: whisper left the graphics card in a meeting, so the speed check (timed with it) runs again next start
  onWhisperGpuOff(() => speedStore(speedFile()).forget())
  hookTranscription({ store, modelPath: () => setup.installed()?.asr, send: (seg) => {
    const order = seg.track === 'them' && seg.speaker ? store.speakerOrder(seg.meetingId, seg.speaker) : []
    const colored = { ...seg, speakerColor: speakerColor(seg.track, seg.speaker, order) }
    win?.webContents.send('transcript:segment', colored); sendWidgetTranscript('transcript:segment', colored)
  },
    nameOf: (id, a, b) => callNames.nameFor(id, a, b),
    refresh: (id) => { win?.webContents.send('transcript:speakers', id); sendWidgetTranscript('transcript:speakers', id) },
    sendPartial: (part) => { win?.webContents.send('transcript:partial', part); sendWidgetTranscript('transcript:partial', part) },
    warn: (code) => tell({ t: 'warn', code }), pidFile: join(userDataDir(), 'whisper-server.pid'),
    // the spoken language picked (with none, the computer's own or English only), read on each chunk so the footer's picker counts at once
    spoken: () => spokenSetting(loadSettings(settingsFile), systemLocale()),
    // Apple's on-device speech for the live words (macOS 26, Apple Silicon); fake mode has a stand-in when a test asks
    speech: {
      host: { platform: process.platform, arch: process.arch, osRelease: isFake() ? (process.env.YOGURT_FAKE_SPEECH === '1' ? '25.4.0' : '24.0.0') : os.release() }, binary: audioHelperPath(),
      ui: () => localeOf(loadSettings(join(userDataDir(), 'settings.json')), systemLocale()), last: () => store.lastLanguage(),
      ...(isFake() ? { locales: async () => ({ available: true, supported: ['en-US', 'es-ES'], installed: ['en-US'] }), install: async () => true } : {}),
    } })
  ipcMain.handle('transcript:get', (_e, id: unknown, o: unknown) => {
    if (!isId(id)) return []
    const order = store.speakerOrder(id)
    const opts = (o && typeof o === 'object' ? o : {}) as { hidden?: unknown; last?: unknown }
    const last = Number.isInteger(opts.last) && (opts.last as number) > 0 ? Math.min(opts.last as number, 1000) : undefined
    return store.segments(id, { hidden: opts.hidden === true, last })
      .map(s => ({ ...s, speakerColor: speakerColor(s.track, s.speaker, order) }))
  })
  // Replay through the live channel so a stale async reply cannot overtake newer words or finals.
  ipcMain.on('transcript:subscribe', (e) => { for (const part of transcriptPartials()) e.sender.send('transcript:partial', part) })
  // hidden echo lines back into the transcript (and search)
  ipcMain.handle('transcript:restore', (_e, id: unknown, ids: unknown) => {
    if (!isId(id)) return
    store.showSegments(id, Array.isArray(ids) ? ids.filter((x): x is number => Number.isInteger(x)) : undefined)
    void indexer.schedule()
    win?.webContents.send('transcript:speakers', id)
    sendWidgetTranscript('transcript:speakers', id)
    notes.refresh(id)
  })
  // each meeting's audio lives in its own folder; a crash keeps what was recorded up to the last 5 s flush
  hookCapture({ dirOf: (id) => join(userDataDir(), 'meetings', id), onStart: onMeetingStart, onStop: onMeetingStop, speech: (id) => speechLocaleFor(id),
    mic: () => loadSettings(settingsFile).mic ?? null,
    // recording that can't go on ends the meeting, with the notes kept
    stopMeeting: (id) => { stopMeeting(id) } })
  // 32 GB and up: the notes model reads each meeting in as it happens (notes/readAhead.ts)
  const readsAhead = !isFake() && readAheadAllowed(os.totalmem())
  // the notes model: one job at a time, recording first; loaded when needed, the best one downloaded
  const engine = isFake() ? new FakeEngine() : new UtilityEngine(join(__dirname, 'engine.js'), { gpuFallback: process.platform !== 'darwin' })
  if (engine instanceof UtilityEngine) probeGpu = () => engine.probe().then((g) => {
    console.info('NOTES', `graphics: ${g.gpuType || 'none'}${g.gpuNames.length ? ` (${g.gpuNames.join(', ')})` : ''}, ${g.vramTotalGB.toFixed(1)} GB`)
    return g
  }, (e) => { console.warn("couldn't check the graphics", e); return null })
  // fake mode: the fixed Mac (a bigger one) unless a test asks for a 16 GB one
  const smallMac = isFake() ? process.env.YOGURT_FAKE_SMALL_MAC === '1' : isSmallMac(os.totalmem())
  // the model on this computer, or the cloud one while Settings → Cloud AI is on and filled in (read each time, so a change counts at once)
  const model = withCloud(createNotesModel({ engine, modelPath: () => { const p = setup.installed(); return p?.recommendedLlm ?? p?.llm } }), () => cloudSetting(loadSettings(settingsFile), openSecret))
  // first run: the notes model lands after recording already works; jobs wait in the queue for it
  // the embedding model (meaning search across meetings) runs in the same worker and is let go with the notes model
  const embedder = createEmbedder({ engine, modelPath: () => setup.installed()?.embed, id: bundledCatalog.embedding.id, dims: bundledCatalog.embedding.dims })
  const queue = createQueue({ recording: () => !!activeMeeting(), smallMac, backlogMs: transcriptionBacklogMs, onIdle: () => { void model.unload(); void embedder.unload() }, modelReady: () => !!setup.installed()?.llm })
  setup.onNotesModel(() => { queue.modelArrived(); conversations.refresh() })
  // chat across meetings: every finished meeting chunked and embedded in the background, last in the queue
  const library = new Library(store.db)
  const indexer = createIndexer({ store, library, embedder, queue })
  indexerRef = indexer
  setup.onEmbedModel(() => void indexer.schedule())
  onMeetingStart(() => queue.recordingChanged())
  onMeetingStop(() => queue.recordingChanged())
  // the meeting is read into the model as it happens, so its notes start within seconds of stopping
  const readAhead = hookReadAhead({
    store, queue, model, live: readsAhead, backlogMs: transcriptionBacklogMs, language: meetingLanguage,
    transcribed: async (id) => { await recordingFinished(id); await transcriptFinished(id) }, onStart: onMeetingStart, onStop: onMeetingStop,
  })
  const folderSuggestions = createFolderSuggestions({ store, queue, model, changed: () => win?.webContents.send('folders:changed') })
  const notes = hookNotes({
    summarized: id => folderSuggestions.schedule(id),
    // Windows and Linux: a note waiting while the model loads says so (a Mac shows what it always did)
    showLoading: platform !== 'darwin',
    store, queue, model, language: meetingLanguage, onStop: onMeetingStopSaved, named: (id) => callNames.finished(id), earlier: (id) => readAhead.parts(id), me,
    // Settings → Language → Notes language, read when the notes are written
    notesLanguage: () => notesLanguageSetting(loadSettings(settingsFile)),
    transcribed: async (id) => { await recordingFinished(id); await transcriptFinished(id) },
    send: (v) => win?.webContents.send('notes:changed', v),
    // the notes are written: the meeting goes into the library for chat across meetings
    changed: () => { win?.webContents.send('meetings:changed'); void indexer.schedule() },
  })
  let resumingId: string | null = null
  ipcMain.handle('meetings:resume', async (_e, id: unknown): Promise<StartResult> => {
    if (!isId(id)) return { error: 'gone' }
    const current = activeMeeting()
    if (current) { goTo(`/note/${current.id}`); return { id: current.id } }
    const existing = store.meeting(id)
    if (!existing || existing.trashedAt != null || (existing.state !== 'stopped' && existing.state !== 'done')) return { error: 'gone' }
    if (resumingId || stopSavePending(id) || finishing || !notes.retryDrafts(id)) return { error: 'failed' }
    resumingId = id
    const analysis = notes.suspendForResume(id)
    let started = false, timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([recordingFinished(id), transcriptFinished(id), callNames.finished(id), analysis.settled]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Previous recording is still finishing')), 30_000) }),
      ])
      clearTimeout(timer)
      await rejoined
      if (finishing || !store.meeting(id)) return { error: 'failed' }
      const append = await prepareAppend(join(userDataDir(), 'meetings', id))
      // Another explicit start may have happened while the old files were settling.
      if (finishing || activeMeeting()) return { error: 'failed' }
      const m = resumeMeeting(id, append)
      if (!m) return { error: 'failed' }
      started = true; goTo(`/note/${id}`)
      return { id }
    } catch (e) {
      console.error('resume recording failed; previous note and recording retained', id, e)
      return { error: 'failed' }
    } finally {
      clearTimeout(timer); resumingId = null; analysis.release(!started)
    }
  })
  // Both Ask surfaces share saved conversations and the same recording-first model queue.
  const conversations = hookConversations({
    store, library, indexer, embedder, queue, model,
    send: (v) => {
      win?.webContents.send('conversations:changed', v)
      if (v.chips.length === 1 && v.chips[0].kind === 'meeting') win?.webContents.send('chat:changed', { ...v, meetingId: v.chips[0].id })
    }, sendList: (l) => win?.webContents.send('conversations:list', l),
    waitsForMeeting: () => smallMac && !!activeMeeting(), waitsForModel: () => !setup.installed()?.llm,
    // a meeting read in ahead during a recording only where reading ahead is allowed (32 GB and up; the fake Mac is big)
    warmAllowed: () => !activeMeeting() || (isFake() ? !smallMac : readAheadAllowed(os.totalmem())),
  })
  const validChips = (value: unknown): value is ContextChip[] => Array.isArray(value) && value.length <= 40 && value.every(c =>
    c && (c.kind === 'meeting' || c.kind === 'folder') && isId(c.id)) && new Set(value.map(c => `${c.kind}:${c.id}`)).size === value.length
  ipcMain.handle('conversations:current', (_e, chips: unknown, fresh: unknown) => {
    if (!validChips(chips)) throw new Error('Invalid context')
    const id = library.current(chips.map(({ kind, id }) => ({ kind, id })), fresh === true)
    win?.webContents.send('conversations:list', conversations.list())
    return id
  })
  ipcMain.handle('conversations:context', (_e, id: unknown, chips: unknown) => {
    if (!isId(id) || !validChips(chips)) throw new Error('Invalid context')
    conversations.context(id, chips.map(({ kind, id }) => ({ kind, id })))
  })
  ipcMain.handle('conversations:remove-context', (_e, id: unknown, chip: unknown) => {
    const chips = [chip]
    if (!isId(id) || !validChips(chips)) throw new Error('Invalid context')
    conversations.removeContext(id, { kind: chips[0].kind, id: chips[0].id })
  })
  ipcMain.handle('conversations:draft', (_e, id: unknown, text: unknown) => {
    if (!isId(id) || typeof text !== 'string' || text.length > 4000) throw new Error('Invalid draft')
    conversations.draft(id, text)
  })
  ipcMain.handle('conversations:targets', (_e, query: unknown) => library.targets(typeof query === 'string' ? query.slice(0, 200) : ''))
  // Compatibility bridge for older renderer clients; all storage and answers now use conversations.
  const meetingChat = (id: string) => library.current([{ kind: 'meeting', id }])
  ipcMain.handle('chat:get', (_e, id: unknown) => isId(id) && store.meeting(id) ? { ...conversations.view(meetingChat(id)), meetingId: id } : undefined)
  ipcMain.handle('chat:ask', (_e, id: unknown, q: unknown) => { if (isId(id) && store.meeting(id) && typeof q === 'string') conversations.ask(meetingChat(id), q) })
  ipcMain.on('chat:stop', (_e, id: unknown) => { if (isId(id) && store.meeting(id)) conversations.stop(meetingChat(id)) })
  ipcMain.handle('chat:clear', (_e, id: unknown) => { if (isId(id) && store.meeting(id)) {
    conversations.stop(meetingChat(id))
    library.current([{ kind: 'meeting', id }], true); conversations.refresh()
  } })
  ipcMain.handle('conversations:list', () => conversations.list())
  ipcMain.handle('conversations:get', (_e, id: unknown) => (isId(id) ? conversations.view(id) ?? null : null))
  ipcMain.handle('conversations:ask', (_e, id: unknown, q: unknown) => ((id === null || isId(id)) && typeof q === 'string' && q.trim() ? conversations.ask(id, q).id : null))
  ipcMain.on('conversations:stop', (_e, id: unknown) => { if (isId(id)) conversations.stop(id) })
  ipcMain.on('conversations:warm', (_e, id: unknown) => { if (isId(id)) conversations.warm(id) })
  ipcMain.handle('conversations:rename', (_e, id: unknown, title: unknown) => { if (isId(id) && typeof title === 'string') conversations.rename(id, title) })
  ipcMain.handle('conversations:delete', (_e, id: unknown) => { if (isId(id)) conversations.remove(id) })
  // a meeting's two tracks, once recording has finished them (fake mode writes wav stand-ins)
  const audioKinds: AudioExt[] = isFake() && process.env.YOGURT_FAKE_AUDIO_M4A === '1' ? ['m4a'] : audioExts(process.platform, isFake())
  const meetingDir = (id: string) => join(userDataDir(), 'meetings', id)
  const finishedMeeting = (id: string) => { const m = store.meeting(id); return !!m && m.state !== 'recording' }
  protocol.handle(AUDIO_SCHEME, createAudioHandler({ dirOf: meetingDir, known: finishedMeeting, ready: async (id) => { await rejoined; await recordingSettled(id); if (isFake()) await waitForFakeAudioMetadata() }, exts: audioKinds }))
  ipcMain.handle('audio:tracks', async (_e, id: unknown) => {
    if (!isId(id) || !finishedMeeting(id)) return []
    // a join (after the meeting, or left over from a crash and redone at launch) rewrites the files: wait for it, 30 s at most
    await Promise.all([recordingSettled(id), rejoined])
    return (['me', 'them'] as const).filter((t) => !!trackFile(meetingDir(id), t, audioKinds))
  })
  // the mic picker under the note's bar: the mics, the chosen one, and switching while recording
  hookMics({ helper: micListHelper(process.platform) === 'system' || isFake() ? runHelper : audioHelper.run, settingsFile, send: (channel, payload) => win?.webContents.send(channel, payload) })
  hookShare({ store, window: () => win })
  hookFolders({ store, changed: () => { win?.webContents.send('folders:changed'); folderSuggestions.refresh() } })
  // every meeting to one file and back; what an import adds shows up on home
  hookBackup({ db: store.db, meetingsDir: join(userDataDir(), 'meetings'), window: () => win, recording: () => !!activeMeeting() || !!resumingId,
    changed: () => { win?.webContents.send('meetings:changed'); win?.webContents.send('conversations:list', conversations.list()); void indexer.refresh(); folderSuggestions.refresh() },
    beforeExport: () => { notes.retryDrafts(); return notes.pendingDraftId() } })
  void hookMcp({
    store, profile: userDataDir(), me, version: app.getVersion(),
    enabled: () => !!loadSettings(settingsFile).aiApps, setEnabled: (on) => { updateSettings(settingsFile, { aiApps: on || undefined }) },
    audio: async (id) => {
      await rejoined; await recordingSettled(id)
      return (['me', 'them'] as const).flatMap((track) => { const path = trackFile(meetingDir(id), track, audioKinds); return path ? [{ track, path }] : [] })
    },
    send: (clients) => win?.webContents.send('mcp:clients', clients),
  })
  // notes only for a meeting that exists: saving one for an unknown id would throw (its row must exist)
  const known = (id: unknown): id is string => isId(id) && !!store.meeting(id)
  ipcMain.handle('notes:get', (_e, id: unknown) => (isId(id) ? notes.view(id) : undefined))
  const saveEdit = (id: unknown, side: unknown, md: unknown, revision: unknown): NoteSaveResult => {
    if (!isId(id) || typeof md !== 'string' || !Number.isSafeInteger(revision) || Number(revision) < 1 || (side !== 'mine' && side !== 'enhanced')) return { revision: Number(revision) || 0, status: 'failed', retained: false }
    return side === 'mine' ? notes.setMine(id, md, Number(revision)) : notes.setEnhanced(id, md, Number(revision))
  }
  ipcMain.handle('notes:set-mine', (_e, id: unknown, md: unknown, revision: unknown) => saveEdit(id, 'mine', md, revision))
  ipcMain.handle('notes:set-enhanced', (_e, id: unknown, md: unknown, revision: unknown) => saveEdit(id, 'enhanced', md, revision))
  ipcMain.on('notes:flush-sync', (e, id: unknown, side: unknown, md: unknown, revision: unknown) => { e.returnValue = saveEdit(id, side, md, revision) })
  ipcMain.on('notes:kept-edits', (_e, id: unknown) => { if (known(id)) notes.keptEdits(id) })
  ipcMain.handle('notes:write-again', (_e, id: unknown) => { if (known(id)) void notes.writeAgain(id) })
  app.on('will-quit', () => engine.dispose())
  // an earlier quit or crash may have left parts unjoined: try again now
  const rejoined = rejoinInterrupted(join(userDataDir(), 'meetings'), async dir => {
    const id = basename(dir), meeting = store.meeting(id)
    if (!meeting || meeting.trashedAt != null || activeMeeting() || resumingId) return
    await joinParts(dir)
  })
  // meetings whose notes a quit or crash cut short: caught up once the models are ready, one at a time
  let caughtUp = false
  // and meetings not in the library yet (or changed since) are indexed, once nothing else is waiting
  const catchUp = () => { if (!caughtUp && setup.state.phase === 'ready') { caughtUp = true; void rejoined.catch(e => console.warn('audio startup repair retained its files', e)).finally(() => { notes.recover(); folderSuggestions.refresh(); void indexer.schedule() }) } }
  setup.onState(catchUp)
  app.on('will-quit', killAllWatches)
  app.on('will-quit', killAllHelpers)
  let flushToken = 0
  const flushRenderer = (): Promise<boolean> => {
    const window = win
    if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return Promise.resolve(true)
    const token = ++flushToken
    return new Promise((resolve) => {
      const done = (saved: boolean) => { clearTimeout(timer); ipcMain.removeListener('notes:flushed', heard); resolve(saved) }
      const heard = (e: Electron.IpcMainEvent, reply: unknown, saved: unknown) => { if (e.sender === window.webContents && reply === token) done(saved === true) }
      const timer = setTimeout(() => done(false), 5000)
      ipcMain.on('notes:flushed', heard)
      window.webContents.send('notes:flush-request', token)
    })
  }
  // Flush the last keystroke and retained drafts before the existing recording/transcription shutdown.
  let finishing = false, discardUnsaved = false
  const resumeEditing = () => {
    finishing = false; allowQuit = false; discardUnsaved = false
    win?.webContents.send('notes:flush-request', null)
  }
  app.on('browser-window-created', (_e, window) => {
    window.webContents.on('will-prevent-unload', (e) => {
      if (window !== win) return
      // Only the explicit native discard choice may override the renderer's final handoff veto.
      if (allowQuit && discardUnsaved) e.preventDefault()
      else if (finishing || allowQuit) resumeEditing()
    })
  })
  app.on('before-quit', (e) => {
    if (allowQuit) return
    e.preventDefault()
    if (finishing) return
    finishing = true
    void (async () => {
      const flushed = await flushRenderer()
      const saved = notes.retryDrafts()
      if (!flushed || !saved) {
        const options = { type: 'warning' as const, title: t("Yogurt couldn't finish saving"),
          message: t("Yogurt couldn't finish saving"), detail: t('Return to your notes to try again. Quitting now may discard your latest changes.'),
          buttons: [t('Return to notes'), t('Quit without saving')], defaultId: 0, cancelId: 0, noLink: true }
        const answer = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        if (answer.response !== 1) {
          const id = notes.pendingDraftId()
          if (id) goTo(`/note/${id}`); else showMain()
          return
        }
        discardUnsaved = true
      }
      // If final unload is vetoed, the resumed UI must describe the same stopped capture.
      const recording = activeMeeting()
      if (recording) stopMeeting(recording.id)
      // Music, recorder files and transcription still receive the same bounded graceful shutdown.
      await Promise.all([media.resume(), settleRecording().then(() => settleTranscription())])
      allowQuit = true
      finishQuit()
    })().catch((err) => console.error('quit was cancelled because saving or shutdown failed', err)).finally(() => {
      if (!allowQuit) resumeEditing()
    })
  })
  app.on('will-quit', stopTranscriptionServer)
  const reminder = createRecordingReminder(() => recordingReminderOn(loadSettings(settingsFile)))
  onMeetingStart(reminder.started)
  onMeetingStop(reminder.stopped)
  ipcMain.handle('meetings:take-recording-reminder', () => reminder.take())
  onMeetingChange(() => win?.webContents.send('meetings:changed'))
  ipcMain.handle('meetings:get', (_e, id: unknown) => {
    const m = isId(id) ? getMeeting(id) : undefined
    if (m) store.noteOpened(m.id)
    return m && { ...m, ...(recordingPaused(m.id) ? { paused: true } : {}) }
  })
  // the person's own title for a note
  ipcMain.handle('meetings:rename', (_e, id: unknown, title: unknown) => { if (isId(id) && typeof title === 'string') renameMeeting(id, title) })
  // who was there, by hand, or from a calendar event picked for the note: unedited notes are written again with them
  ipcMain.handle('meetings:rename-attendee', (_e, id: unknown, index: unknown, name: unknown, expected: unknown) => {
    if (!isId(id) || typeof index !== 'number' || typeof name !== 'string') return false
    const before = store.meeting(id)
    const person = before?.attendees[index]
    if (!person || !expected || typeof expected !== 'object') return false
    const previous = expected as { name?: unknown; email?: unknown }
    if (person.email ? previous.email !== person.email : previous.email != null || previous.name !== person.name) return false
    if (!store.renameAttendee(id, index, name)) return false
    notes.renamed(id, before.attendees, store.meeting(id)!.attendees)
    win?.webContents.send('meetings:changed')
    win?.webContents.send('calendar:changed')
    void indexer.refresh()
    return true
  })
  ipcMain.handle('meetings:set-attendees', (_e, id: unknown, people: unknown) => { if (isId(id) && setAttendees(id, people)) notes.applyPeople(id) })
  ipcMain.handle('meetings:link-event', async (_e, id: unknown, eventId: unknown, day?: unknown) => {
    const m = isId(id) ? store.meeting(id) : undefined
    if (!m) return
    if (eventId === null) { unlinkEvent(m.id); return }
    if (typeof eventId !== 'string') return
    const at = day ?? m.eventStartedAt ?? m.startedAt
    if (typeof at !== 'number' || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw new Error('Invalid calendar day')
    const event = (await eventsOn(at)).find((e) => matchesEvent(e, eventId))
    if (!event) throw new Error('Calendar event unavailable')
    if (linkEvent(m.id, event)) notes.applyPeople(m.id)
  })
  // gone for good, audio too; never while it records
  const removeForGood = (id: unknown) => id === resumingId ? Promise.resolve('failed' as const) : isId(id) && stopSavePending(id) ? Promise.resolve('save-pending' as const) : deleteMeeting(id, {
    store, dirOf: meetingDir,
    cancel: (id) => { queue.cancel(id); conversations.forgetMeeting(id); indexer.forget(id) },
    // Actual writer completion: deleteMeeting refuses deletion if this wait times out.
    settle: async (id) => { await Promise.all([recordingFinished(id), transcriptFinished(id)]) },
    removed: (id) => {
      notes.forgetDrafts(id)
      win?.webContents.send('meetings:changed'); win?.webContents.send('folders:changed')
      // the note on screen was this one: back home
      if (route === `/note/${id}`) { route = ''; win?.webContents.send('nav:go', route) }
    },
  })
  ipcMain.handle('meetings:delete', (_e, id: unknown) => removeForGood(id))
  // Delete in a list or a note: to the Trash, kept until restored or deleted for good there (30 days at most)
  ipcMain.handle('meetings:trash', (_e, id: unknown) => id === resumingId ? 'failed' : isId(id) && stopSavePending(id) ? 'save-pending' : moveToTrash(id, {
    store,
    moved: (id) => {
      indexer.forget(id)
      win?.webContents.send('meetings:changed'); win?.webContents.send('folders:changed')
      if (route === `/note/${id}`) { route = ''; win?.webContents.send('nav:go', route) }
    },
  }))
  ipcMain.handle('meetings:restore', (_e, id: unknown) => {
    if (!isId(id) || store.meeting(id)?.trashedAt == null) return
    store.restoreMeeting(id); indexer.restored(id)
    win?.webContents.send('meetings:changed'); win?.webContents.send('folders:changed')
  })
  ipcMain.handle('meetings:trashed', () => store.trashed())
  ipcMain.handle('meetings:empty-trash', () => emptyTrash({ store, remove: removeForGood }))
  // a meeting in the Trash for 30 days goes for good: at launch, and twice a day for a Yogurt that stays open
  const purge = () => void purgeTrash({ store, remove: removeForGood })
  purge(); setInterval(purge, 12 * 60 * 60 * 1000).unref()
  const tidyPrepared = () => {
    try {
      // Keep on-screen drafts and any on-disk capture, even if its state was never saved.
      const discussed = new Set(library.conversations().filter(c => c.draft || c.draftChips.length || library.turns(c.id).length)
        .flatMap(c => [...c.chips, ...c.draftChips, ...(c.firstChips ?? [])].filter(chip => chip.kind === 'meeting').map(chip => chip.id)))
      if (store.tidyPrepared(Date.now(), id => route === `/note/${id}` || existsSync(meetingDir(id)) || discussed.has(id))) {
        win?.webContents.send('meetings:changed'); win?.webContents.send('folders:changed')
      }
    } catch (e) { console.warn('tidying prepared notes failed', e) }
  }
  tidyPrepared(); setInterval(tidyPrepared, 60_000).unref()
  ipcMain.handle('meetings:cards', (_e, o: { before?: { at: number; id: string }; limit?: number; folder?: string }) => {
    const limit = Math.max(1, Math.min(1000, Number(o?.limit) || 40))
    const b = o?.before
    return store.meetingCards({ limit, before: b && typeof b.at === 'number' && typeof b.id === 'string' ? b : undefined, ...(isId(o?.folder) ? { folder: o.folder } : {}) })
      .map((m) => ({ ...withStopState(m), ...(recordingPaused(m.id) ? { paused: true } : {}) }))
  })
  const calendarList = async () => {
    const list = await calendars(), hidden = loadSettings(settingsFile).hiddenCalendarIds ?? []
    return { status: calendarStatus(), calendars: list.map((c) => ({ ...c, enabled: !hidden.includes(c.id) })) }
  }
  ipcMain.handle('calendar:list', calendarList)
  ipcMain.handle('calendar:set-enabled', async (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || id.length > 1024 || typeof enabled !== 'boolean') return false
    if (!(await calendars()).some((c) => c.id === id)) return false
    const hidden = new Set(loadSettings(settingsFile).hiddenCalendarIds ?? [])
    if (enabled) hidden.delete(id); else hidden.add(id)
    updateSettings(settingsFile, { hiddenCalendarIds: [...hidden] })
    refreshCalendarConsumers()
    win?.webContents.send('calendar:changed')
    return true
  })
  ipcMain.handle('calendar:day', async (_e, at: unknown) => {
    if (typeof at !== 'number' || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return { status: 'error', events: [] }
    const events = (await eventsOn(at)).map((event) => {
      const meeting = eventIds(event).map((id) => store.meetingForEvent(id)).find(Boolean)
      const note = meeting && withStopState(meeting)
      return { ...event, attendees: resolvePeople(store.db, event.attendees), ...(note ? { note: { id: note.id, state: note.state } } : {}) }
    })
    return { status: calendarStatus(), events }
  })
  ipcMain.handle('calendar:coming-up', async () => {
    const events = (await comingUp()).map(event => ({ ...event, attendees: resolvePeople(store.db, event.attendees) }))
    return { status: calendarStatus(), events }
  })
  // not asked yet: the Mac's own question; turned off: the Mac's settings, where only the person can turn it on
  ipcMain.handle('calendar:connect', async () => {
    const was = await refreshCalendarStatus()
    if (was === 'notDetermined') return requestCalendarAccess()
    if (was === 'denied') {
      if (isFake()) settingsOpened++
      else void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars')
    }
    return was
  })
  ipcMain.handle('search:query', async (_e, q: unknown, folder: unknown) => {
    if (typeof q !== 'string') return []
    const query = q.slice(0, 200)
    // opened from a folder's page: only its meetings
    const sp = isId(folder) ? folder : undefined
    // fake mode: short questions answer late, so a test can see an older answer never replace a newer one
    if (isFake() && process.env.YOGURT_FAKE_SEARCH_SLOW === '1' && query.trim().length <= 4) await new Promise((r) => setTimeout(r, 1000))
    const hits = query.trim() ? store.search(query, 30, sp) : store.meetingCards({ limit: 8, folder: sp }).map((c) => ({ meetingId: c.id, snippet: '', parts: [] }))
    return hits.flatMap((h) => {
      const m = store.meeting(h.meetingId)
      if (!m) return []
      const parts = h.parts.length ? h.parts : [{ text: store.preview(m.id), hit: false }]
      return [{ meetingId: m.id, title: m.title, startedAt: m.startedAt, parts: parts.filter((p) => p.text) }]
    })
  })
  // the window's own moves (home, a note from the list): remembered here so a reload stays where it was
  ipcMain.on('nav:go', (_e, r: unknown) => {
    if (!isAppRoute(r)) return
    route = r
    win?.webContents.send('nav:go', route)
  })
  ipcMain.handle('nav:current', () => route)
  ipcMain.handle('nav:take-ask', () => { const pending = pendingAsk; pendingAsk = false; return pending })
  // opened by the Mac at login: just the menu bar, until a call or a click
  // opened by an AI app's yogurt-mcp off a Mac (--hidden): the same, so no window jumps in front of it
  if (!openedAtLogin() && !startedHidden(process.platform, process.argv)) createWindow()
  startDetection()
  void setup.start()
  void offerInstallerEject()
  // new versions from GitHub Releases, downloaded in the background and installed on quit
  const updatesAvailable = updatesOn({ packaged: app.isPackaged, fake: isFake(), profile: !!process.env.YOGURT_USER_DATA, platform: process.platform, appImage: !!process.env.APPIMAGE,
    feed: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    preview: app.isPackaged && isPreviewBuild((() => { try { return readFileSync(join(app.getAppPath(), 'package.json'), 'utf8') } catch { return '' } })()) })
  hookUpdates({ file: join(userDataDir(), 'settings.json'), available: updatesAvailable, recording: () => !!activeMeeting() })
    .catch((err) => console.warn("couldn't start looking for new versions", err))
  // the Dock icon: the main window, even while the widget is up
  app.on('activate', showMain)
})

// on a Mac Yogurt lives on in the menu bar, so it still notices calls; Quit is in its menu
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
