import { BrowserWindow, ipcMain, Notification, screen, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { Prompt } from './detect'
import type { Meeting } from './store'
import type { PromptAction, PromptView } from '../shared/types'
import { t } from '../shared/i18n'
import { floatingType, floatOverFullScreen } from './float'

const BACKGROUND = process.env.YOGURT_BACKGROUND === '1'
const ACTIONS: readonly string[] = ['take-notes', 'close', 'stop', 'keep-going'] satisfies PromptAction[]

/** the card at the top right: small, frameless, on top of everything, never takes focus from what the person is doing */
function createCard(kind: PromptView['kind'], os = 'darwin'): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = kind === 'start' ? 381 : 380, height = kind === 'start' ? 60 : 128
  const background = () => nativeTheme.shouldUseDarkColors ? '#29292B' : '#FFFFFF'
  const type = floatingType(os)
  const w = new BrowserWindow({
    ...(type ? { type } : {}),
    width, height, x: workArea.x + workArea.width - width - 16, y: workArea.y + 12,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, acceptFirstMouse: true, show: false, hasShadow: true, roundedCorners: true,
    backgroundColor: background(),
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, backgroundThrottling: false },
  })
  const appearance = () => { if (!w.isDestroyed()) w.setBackgroundColor(background()) }
  nativeTheme.on('updated', appearance)
  w.once('closed', () => nativeTheme.removeListener('updated', appearance))
  floatOverFullScreen(w)
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#prompt`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'prompt' })
  return w
}

/**
 * The two cards ("Take notes?" and "Stop recording?") and what their buttons do.
 * Main decides what the buttons mean; this only shows the card and passes the click on.
 */
export function createPrompts(d: {
  /** is a Yogurt window on screen? If not, a system notification says it too */
  windowVisible(): boolean
  takeNotes(p: Prompt): void
  stop(meetingId: string): void
  dismissed(key: string): void
  keepGoing(): void
  /** show a meeting's note (clicking "Call ended") */
  open(meetingId: string): void
  /** the computer the card is made for (a tool window off a Mac) */
  os?: string
}) {
  let card: BrowserWindow | undefined
  let view: PromptView | null = null
  let prompt: Prompt | null = null
  /** the system notification said with the card, while nothing of Yogurt is on screen; kept so its click still arrives */
  let notice: { title: string; body: string; click: () => void; n?: Notification } | null = null

  const close = () => {
    view = null; prompt = null
    if (card && !card.isDestroyed()) card.destroy()
    card = undefined
    notice?.n?.close(); notice = null
  }
  /** a button on the card, or a click on its notification (the card's yes: take notes, or stop) */
  const act = (action: PromptAction) => {
    const v = view, p = prompt
    close()
    if (!v) return
    if (v.kind === 'start') {
      if (action === 'take-notes' && p) d.takeNotes(p)
      else d.dismissed(v.key)
    } else if (action === 'stop') d.stop(v.meetingId)
    else d.keepGoing()
  }
  const show = (v: PromptView) => {
    view = v
    if (card && !card.isDestroyed()) card.destroy()
    card = createCard(v.kind, d.os)
    card.on('closed', () => { card = undefined })
    // hidden in tests so no window pops up; the page still runs
    if (!BACKGROUND) card.once('ready-to-show', () => card?.showInactive())
    notice?.n?.close(); notice = null
    if (!d.windowVisible()) {
      const title = v.kind === 'start' ? t('Take notes?') : t('Stop recording?')
      const body = v.title || (v.kind === 'start' && v.app ? t('{app} call', { app: v.app }) : '')
      // clicking it says yes, for this card only (a newer card has its own)
      const mine = v
      const click = () => { if (view === mine) act(mine.kind === 'start' ? 'take-notes' : 'stop') }
      notice = { title, body, click }
      // test runs show none: the click is made through the fake hooks
      if (!BACKGROUND && Notification.isSupported()) {
        const n = new Notification({ title, body, silent: true })
        n.on('click', click)
        n.show()
        notice.n = n
      }
    }
  }

  ipcMain.handle('prompt:state', () => view)
  ipcMain.handle('prompt:act', (_e, action: unknown) => { if (ACTIONS.includes(action as PromptAction)) act(action as PromptAction) })

  return {
    offer(p: Prompt) { prompt = p; show({ kind: 'start', key: p.key, app: p.app, title: p.title }) },
    askStop(m: Meeting) { prompt = null; show({ kind: 'stop', meetingId: m.id, title: m.title }) },
    hide: close,
    /** the recording stopped by itself because the call ended: no card, a notification while Yogurt is away; clicking it opens the note to resume */
    stopped(m: Meeting) {
      close()
      if (d.windowVisible()) return
      const title = t('Call ended. Recording stopped.'), body = m.title
      const click = () => { notice?.n?.close(); notice = null; d.open(m.id) }
      notice = { title, body, click }
      if (!BACKGROUND && Notification.isSupported()) {
        const n = new Notification({ title, body, silent: true })
        n.on('click', click)
        n.show()
        notice.n = n
      }
    },
    /** for tests: the notification shown with the card (null: none), and a click on it */
    notice: () => (notice ? { title: notice.title, body: notice.body } : null),
    clickNotice: () => notice?.click(),
  }
}
