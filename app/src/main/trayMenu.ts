import { t } from '../shared/i18n'
import { dayLabel, timeOf } from '../shared/dates'
import { formatElapsed } from '../shared/wave'
import type { CalEvent } from './calendar'

export type TrayItem = { id: 'status' | 'open' | 'new' | 'stop' | 'pause' | 'ask' | 'next' | 'join' | 'recent' | 'settings' | 'quit' | 'sep' | `note:${string}`; label: string; enabled: boolean; accelerator?: string; submenu?: TrayItem[] }
type Recent = { id: string; title: string; startedAt: number }

/** The agenda's meeting-shaped events only, still happening or starting later today. */
export function nextTrayEvent(events: CalEvent[], now = Date.now()): CalEvent | undefined {
  const end = new Date(now); end.setHours(24, 0, 0, 0)
  return events.filter(e => e.end > now && e.start < end.getTime() && (e.attendees.length > 0 || !!e.url?.trim()))
    .sort((a, b) => a.start - b.start)[0]
}

export const trayTitle = (active: { elapsedMs: number; paused: boolean } | null): string =>
  active ? `${active.paused ? '' : '● '}${formatElapsed(active.elapsedMs)}` : ''

/** Keep native and hidden-test menus identical; only the native icon is optional. */
export function trayItems(active: { id?: string; title: string; paused?: boolean } | null, next?: CalEvent, recent: Recent[] = [], now = Date.now(), os = 'darwin'): TrayItem[] {
  const sep: TrayItem = { id: 'sep', label: '', enabled: true }
  const open: TrayItem = { id: 'open', label: t('Open Yogurt'), enabled: true }
  const ask: TrayItem = { id: 'ask', label: t('Ask Yogurt'), enabled: true }
  const settings: TrayItem = { id: 'settings', label: t('Settings…'), accelerator: os === 'darwin' ? 'Command+,' : 'Ctrl+,', enabled: true }
  const quit: TrayItem = { id: 'quit', label: t('Quit Yogurt'), enabled: true }
  const history: TrayItem = { id: 'recent', label: t('Recent'), enabled: recent.length > 0, submenu: [...recent].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5)
    .map(m => ({ id: `note:${m.id}`, label: `${m.title || t('Untitled meeting')} · ${dayLabel(m.startedAt)}`, enabled: true })) }
  if (!active) return [
    ...(next ? [{ id: 'next' as const, label: next.start <= now ? t('Now: {title}', { title: next.title || t('Meeting') }) : `${next.title || t('Meeting')} · ${timeOf(next.start)}`, enabled: true },
      ...(next.url?.trim() ? [{ id: 'join' as const, label: t('Join and record'), enabled: true }] : [])] : []),
    { id: 'new', label: t('Start recording'), enabled: true }, ask, history, sep, open, settings, sep, quit,
  ]
  return [
    { id: 'status', label: active.paused ? t('Paused: {title}', { title: active.title }) : t('Recording: {title}', { title: active.title }), enabled: false },
    { id: 'pause', label: active.paused ? t('Resume recording') : t('Pause recording'), enabled: true },
    { id: 'stop', label: t('Finish recording'), enabled: true }, sep,
    ask, open, history, settings, sep, quit,
  ]
}

/**
 * How the icon looks. A Mac: the template mark (the system tints it) with the timer beside it.
 * Windows and Linux have no text beside a tray icon: a colour mark, a recording one while it records, the time in the tooltip.
 */
export function trayLook(os: string, active: { paused: boolean } | null, elapsedMs: number): { icon: 'tray' | 'tray-color' | 'tray-recording'; template: boolean; title: string | null; tooltip: string } {
  const tooltip = active?.paused ? t('Recording paused') : active ? t('Yogurt is recording') : 'Yogurt'
  if (os === 'darwin') return { icon: 'tray', template: true, title: trayTitle(active ? { elapsedMs, paused: active.paused } : null), tooltip }
  return { icon: active && !active.paused ? 'tray-recording' : 'tray-color', template: false, title: null, tooltip: active ? `${tooltip} · ${formatElapsed(elapsedMs)}` : tooltip }
}

/** dbus-send's answer to NameHasOwner org.kde.StatusNotifierWatcher: is there a tray to show an icon in? */
export const hasTrayHost = (stdout: string): boolean => /\bboolean true\b/.test(stdout)
