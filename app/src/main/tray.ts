import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { activeMeeting, onMeetingChange } from './meeting'
import { execFile } from 'node:child_process'
import { hasTrayHost, nextTrayEvent, trayItems, trayLook, type TrayItem } from './trayMenu'
import { onLanguage, t } from '../shared/i18n'
import { onRecordingEvent, recordingPaused } from './capture'
import type { CalEvent } from './calendar'

function iconPath(name = 'tray'): string {
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, `${name}.png`),
    join(__dirname, `../../resources/${name}.png`),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

/** Linux: is there a tray (a StatusNotifier host) to show the icon in? GNOME has one only with its AppIndicator extension. */
export const linuxTrayHost = (): Promise<boolean> => new Promise((done) => {
  execFile('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.kde.StatusNotifierWatcher'],
    { timeout: 3000 }, (error, stdout) => done(!error && hasTrayHost(stdout)))
})

/**
 * Yogurt in the menu bar (the notification area on Windows, the tray on Linux): it keeps running there with its window closed, so it still notices calls.
 * The menu says what is recording. Tests run without it on screen (show: false) and read the menu through items().
 */
export function createTray(d: { show: boolean; visible?: boolean; open(): void; newNote(): void; stop(id: string): void
  pause(id: string, paused: boolean): void; ask(): void; settings(): void; openNote(id: string): void
  events(): Promise<CalEvent[]>; event(event: CalEvent, join: boolean): Promise<void>
  recent(): { id: string; title: string; startedAt: number }[]; elapsed(): number; now?: () => number
  /** the computer: a Mac's template icon and timer title, a colour icon elsewhere */
  os?: string
  /** Linux: whether a tray host is there to show the icon */
  host?: () => Promise<boolean>
}) {
  const os = d.os ?? 'darwin'
  let visible = d.visible !== false, hosted = true, iconName = ''
  let tray: Tray | undefined
  let items: TrayItem[] = []
  let events: CalEvent[] = []
  const now = d.now ?? Date.now
  const act = (id: TrayItem['id']) => {
    const m = activeMeeting()
    if (id === 'open') d.open()
    else if (id === 'new' && !m) d.newNote()
    else if (id === 'ask') d.ask()
    else if (id === 'settings') d.settings()
    else if (id.startsWith('note:')) d.openNote(id.slice(5))
    else if ((id === 'next' || id === 'join') && !m) {
      const event = nextTrayEvent(events, now())
      if (event) void d.event(event, id === 'join').catch(error => console.error('Menu bar event action failed', error))
    }
    else if (id === 'pause' && m) d.pause(m.id, !recordingPaused(m.id))
    else if (id === 'stop' && m) d.stop(m.id)
    else if (id === 'quit') app.quit()
  }
  const look = () => {
    const m = activeMeeting()
    return trayLook(os, m ? { paused: recordingPaused(m.id) } : null, d.elapsed())
  }
  const image = (name: string) => {
    const icon = nativeImage.createFromPath(iconPath(name))
    if (os === 'darwin') icon.setTemplateImage(true)
    return icon
  }
  // each second while recording: the timer beside a Mac's icon, the tooltip elsewhere
  const title = () => {
    const l = look()
    if (l.title !== null) tray?.setTitle(l.title, { fontType: 'monospacedDigit' })
    else tray?.setToolTip(l.tooltip)
  }
  const template = (list: TrayItem[]): MenuItemConstructorOptions[] => list.map(i => i.id === 'sep' ? { type: 'separator' }
    : { label: i.label, enabled: i.enabled, accelerator: i.accelerator, ...(i.submenu ? { submenu: template(i.submenu) } : { click: () => act(i.id) }) })
  const refresh = () => {
    const m = activeMeeting()
    const paused = !!m && recordingPaused(m.id)
    items = trayItems(m ? { id: m.id, title: m.title, paused } : null, nextTrayEvent(events, now()), d.recent(), now(), os)
    if (!tray) return
    tray.setContextMenu(Menu.buildFromTemplate(template(items)))
    const l = look()
    if (l.icon !== iconName) { tray.setImage(image(l.icon)); iconName = l.icon }
    title()
    tray.setToolTip(l.tooltip)
  }
  const setVisible = (on: boolean) => {
    visible = on
    if (!on || !d.show) {
      tray?.destroy()
      tray = undefined
    } else if (!tray) {
      iconName = look().icon
      tray = new Tray(image(iconName))
      tray.on('mouse-down', refresh)
      // Windows: a left click opens Yogurt and a right click shows the menu (Linux trays mostly show the menu)
      if (os !== 'darwin') tray.on('click', () => d.open())
    }
    refresh()
  }
  let calendarRevision = 0
  const refreshCalendar = async () => {
    const revision = ++calendarRevision
    try {
      const result = await d.events()
      if (revision === calendarRevision) { events = result; refresh() }
    } catch (error) { console.warn('Menu bar calendar unavailable', error) }
  }
  setVisible(visible)
  void d.host?.().then((yes) => {
    hosted = yes
    if (!yes) console.warn('TRAY no tray host here (GNOME needs the AppIndicator extension): closing the window minimises it')
  })
  void refreshCalendar()
  const clock = setInterval(() => { if (tray && activeMeeting()) title() }, 1000)
  const calendar = setInterval(() => void refreshCalendar(), 60_000)
  clock.unref(); calendar.unref()
  app.on('will-quit', () => { clearInterval(clock); clearInterval(calendar) })
  onMeetingChange(refresh)
  onLanguage(refresh)
  onRecordingEvent((e) => { if (e.t === 'paused') refresh() })
  return {
    setVisible, refreshCalendar, items: () => { refresh(); return items.map((i) => i.label) }, click: act,
    /** whether the person can see the icon (on in Settings, and a tray to show it in): closing hides the window only then */
    shown: () => visible && hosted,
    /** for tests: each item's shortcut */
    accelerators: () => Object.fromEntries(items.filter((i) => i.accelerator).map((i) => [i.label, i.accelerator])),
  }
}
