import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ScrollFade } from './ScrollFade'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, ExternalLink, Link2, Link2Off, X } from 'lucide-react'
import type { CalEvent, CalendarStatus, Meeting } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'
import { noteDateLabel, timeOf } from '../dates'
import { useNotePopover } from '../useNotePopover'
import { nearestEvents, shiftCalendarDay } from '../../../shared/calendarPicker'
import { peopleSummary, useMyName } from './People'

export function NoteDate({ m }: { m: Meeting }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const chip = useRef<HTMLButtonElement>(null)
  const close = useCallback((restore = true) => { setOpen(false); if (restore) chip.current?.focus({ preventScroll: true }) }, [])
  return <div className="relative">
    <button ref={chip} data-testid="note-date" aria-haspopup="dialog" aria-expanded={!!open} onClick={e => setOpen(o => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
      className="note-chip flex items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
      <CalendarDays size={14} strokeWidth={1.75} aria-hidden="true" />{noteDateLabel(m.startedAt)}
    </button>
    {open && <DateCard key={`${m.id}/${m.eventId}`} m={m} chip={chip} pointer={open === 'pointer'} onClose={close} />}
  </div>
}

function DateCard({ m, chip, pointer, onClose }: { m: Meeting; chip: RefObject<HTMLButtonElement | null>; pointer: boolean; onClose: (restore?: boolean) => void }) {
  const card = useRef<HTMLDivElement>(null)
  // no calendar on this computer (Windows, Linux): the date and length only, as for a note with no event
  const calendar = window.yogurt.capabilities.calendar
  const linked = calendar && !!m.eventId
  const [event, setEvent] = useState<CalEvent | null>()
  const [revision, setRevision] = useState(0)
  const [picking, setPicking] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  useNotePopover(card, chip, onClose)
  useEffect(() => {
    if (!linked) return
    let active = true
    setEvent(undefined)
    void window.yogurt.calendar.day(m.eventStartedAt ?? m.startedAt).then(day => {
      if (active) setEvent(day.status === 'granted' ? day.events.find(e => e.id === m.eventId || e.aliases?.includes(m.eventId!)) ?? null : null)
    }, () => { if (active) setEvent(null) })
    return () => { active = false }
  }, [linked, m.eventId, m.eventStartedAt, m.startedAt, revision])
  const at = event?.start ?? m.startedAt
  const minutes = Math.max(0, Math.round((m.durationMs ?? (m.endedAt ? m.endedAt - m.startedAt : m.state === 'recording' ? Date.now() - m.startedAt : 0)) / 60_000))
  const url = event?.url?.trim()
  return <div ref={card} data-testid="note-date-card" data-pointer={pointer} data-anchor="start" role="dialog" aria-label={t('Date')}
    className="people-card menu-entry note-date-card absolute start-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-48px))] rounded-lg border border-line bg-float text-ink shadow-[var(--shadow)]"
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
    <div className="agenda-inspector-content">
      <div className="agenda-inspector-heading">
        <h3 data-testid="note-date-heading" tabIndex={linked ? undefined : -1}>{linked
          ? <button ref={toggle} data-testid="note-date-events-toggle" className="note-date-event-toggle" aria-expanded={picking} onClick={() => setPicking(v => !v)}><span>{event?.title || m.title}</span><ChevronDown size={15} aria-hidden="true" /></button>
          : new Date(at).toLocaleDateString(language(), { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</h3>
        <button className="workspace-icon" data-testid="note-date-close" aria-label={t('Close')} onClick={() => onClose()}><X size={16} aria-hidden="true" /></button>
      </div>
      {!picking && <><div className="agenda-inspector-line"><Clock size={15} aria-hidden="true" /><div>
        <p>{timeOf(at)}{event ? ` – ${timeOf(event.end)}` : ` · ${t('{count} min', { count: minutes })}`}</p>
        {linked && <p className="agenda-inspector-muted">{new Date(at).toLocaleDateString(language(), { weekday: 'long', month: 'short', day: 'numeric' })}</p>}
      </div></div>
      {linked && !event && <p role="status" className="text-xs text-muted">{event === undefined ? t('Looking at your calendar…') : t('Calendar event unavailable')}
        {event === null && <button className="ms-2 underline" onClick={() => setRevision(n => n + 1)}>{t('Try again')}</button>}
      </p>}
      {event && (event.calendar || url) && <div className="agenda-inspector-footer">
        {event.calendar && <div className="agenda-inspector-line"><CalendarDays size={15} aria-hidden="true" /><p>{event.calendar.name}<span className="agenda-inspector-muted">{event.calendar.source}</span></p></div>}
        {url && <div className="agenda-inspector-actions">
          <a className="workspace-button agenda-open-note" title={t('Join meeting')} href={url} target="_blank" rel="noreferrer"><span>{t('Join meeting')}</span><ExternalLink size={12} aria-hidden="true" /></a>
        </div>}
      </div>}
      {calendar && !m.eventId && <div className="agenda-inspector-actions"><button ref={toggle} data-testid="note-date-events-toggle" className="workspace-button agenda-open-note" title={t('Link to a calendar event')} aria-expanded={picking} onClick={() => setPicking(true)}><Link2 size={13} aria-hidden="true" /><span>{t('Link to a calendar event')}</span></button></div>}
      </>}
      {picking && <EventPicker m={m} onLinked={() => { setPicking(false); toggle.current?.focus({ preventScroll: true }) }} />}
    </div>
  </div>
}

function EventPicker({ m, onLinked }: { m: Meeting; onLinked: () => void }) {
  const [day, setDay] = useState(m.eventStartedAt ?? m.startedAt)
  const [result, setResult] = useState<{ status: CalendarStatus; events: CalEvent[] }>()
  const [revision, setRevision] = useState(0)
  const [linking, setLinking] = useState(false), [linkError, setLinkError] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const previous = useRef<HTMLButtonElement>(null)
  const me = useMyName()
  useEffect(() => {
    let active = true
    setResult(undefined)
    void window.yogurt.calendar.day(day).then(value => {
      if (active) setResult({ ...value, events: nearestEvents(value.events, m.startedAt) })
    }, () => { if (active) setResult({ status: 'error', events: [] }) })
    return () => { active = false }
  }, [day, revision, m.startedAt])
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0
    ;(list.current?.querySelector<HTMLButtonElement>('[data-event-id]') ?? previous.current)?.focus({ preventScroll: true })
  }, [result])
  const link = async (eventId: string | null) => {
    if (linking) return
    setLinking(true); setLinkError(false)
    try { await window.yogurt.meetings.linkEvent(m.id, eventId, day); onLinked() }
    catch { setLinkError(true) }
    finally { setLinking(false) }
  }
  const connect = () => void window.yogurt.calendar.connect().then(() => setRevision(n => n + 1), () => setResult({ status: 'error', events: [] }))
  return <div className="note-date-picker">
    <div className="note-date-days">
      <button type="button" ref={previous} className="workspace-icon" data-testid="note-date-previous" aria-label={t('Previous day')} disabled={linking} onClick={() => setDay(d => shiftCalendarDay(d, -1))}><ChevronLeft size={15} aria-hidden="true" /></button>
      <span aria-live="polite">{new Date(day).toLocaleDateString(language(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <button type="button" className="workspace-icon" data-testid="note-date-next" aria-label={t('Next day')} disabled={linking} onClick={() => setDay(d => shiftCalendarDay(d, 1))}><ChevronRight size={15} aria-hidden="true" /></button>
    </div>
    <ScrollFade enabled={!!result?.events.length}><div ref={list} data-testid="note-date-events" className="note-date-events" role="group" aria-label={t('Select calendar event')} onKeyDown={e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-event-id]:not(:disabled)'))
      if (!rows.length) return
      e.preventDefault()
      const index = rows.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      rows[next].focus({ preventScroll: true }); rows[next].scrollIntoView({ block: 'nearest', container: 'nearest' } as ScrollIntoViewOptions)
    }}>
      {!result ? <p role="status">{t('Looking at your calendar…')}</p>
        : result.status !== 'granted' ? <div className="note-date-calendar-error"><p>{result.status === 'error' ? t("Yogurt couldn't read your calendar") : t('Calendar access is off')}</p><button className="underline" onClick={result.status === 'error' ? () => setRevision(n => n + 1) : connect}>{result.status === 'error' ? t('Try again') : t('Connect calendar')}</button></div>
        : !result.events.length ? <p data-testid="note-date-events-none">{t('No calendar events on this day.')}</p>
        : result.events.map(e => <button key={e.id} data-event-id={e.id} data-testid="note-date-event" className="note-date-event" disabled={linking} onClick={() => void link(e.id)}>
          <span><strong>{e.title || t('Meeting')}</strong><small>{timeOf(e.start)} – {timeOf(e.end)}</small>{!!e.attendees.length && <small>{peopleSummary(e.attendees, me)}</small>}</span>
          {(m.eventId === e.id || e.aliases?.includes(m.eventId!)) && <Check size={14} aria-hidden="true" />}
        </button>)}
    </div></ScrollFade>
    {m.eventId && <button data-testid="note-date-unlink" className="note-date-link" disabled={linking} onClick={() => void link(null)}><Link2Off size={14} aria-hidden="true" /><span>{t('Unlink calendar event')}<small>{t('Keep the title, attendees and notes.')}</small></span></button>}
    {linkError && <p role="alert" className="text-xs text-danger">{t("Yogurt couldn't update the calendar link. Try again.")}</p>}
  </div>
}
