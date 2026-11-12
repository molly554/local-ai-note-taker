import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ScrollFade } from './ScrollFade'
import { LoadingContent } from './LoadingContent'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, ExternalLink, FileText, Mic, UsersRound, X } from 'lucide-react'
import type { AgendaEvent, CalendarStatus, MeetingCard } from '../../../shared/types'
import { rememberedScroll, useScrollMemory } from '../useScrollMemory'
import { language, t } from '../../../shared/i18n'
import { agendaNoteAction } from '../../../shared/agendaNote'
import { pickNext } from '../../../shared/comingUp'
import { daysAgo, timeOf, useDay } from '../dates'
import { eventPhase, shiftDay, weekDates } from '../agenda'
import { useAgendaCard } from '../useAgendaCard'
import { peopleSummary, personName, useMyName } from './People'

type Actions = {
  recording?: MeetingCard
  onStart: (id: string) => Promise<void>
  onOpen: (id: string) => void
}
type Day = { at: number; status: CalendarStatus; events: AgendaEvent[] }

type Inspection = { at: number; id: string }
let lastView: { selected: number; week: number } | undefined

export function Agenda({ revision, recording, onStart, onOpen }: Actions & { revision: number }) {
  const today = useDay()
  const me = useMyName()
  const [selected, setSelected] = useState(() => lastView?.selected ?? shiftDay(Date.now(), 0))
  const [weekAnchor, setWeekAnchor] = useState(() => lastView?.week ?? selected)
  const [loaded, setLoaded] = useState<Day>()
  const [inspected, setInspected] = useState<Inspection>()
  const opener = useRef<HTMLButtonElement | null>(null)
  const closeDetails = useCallback((restoreFocus = true) => { setInspected(undefined); if (restoreFocus) opener.current?.focus() }, [])
  const [jump, setJump] = useState(0)
  const initialized = useRef<string | undefined>(undefined)
  const lastJump = useRef(jump)
  const [now, setNow] = useState(Date.now)
  const seq = useRef(0)
  const generation = useRef(0)
  const days = useRef(new Map<number, Day>())
  const pending = useRef(new Map<number, Promise<Day | undefined>>())
  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setNow(Date.now())
    let read = pending.current.get(selected)
    if (!read) {
      const startedIn = generation.current
      read = window.yogurt.calendar.day(selected)
        .then((day): Day => ({ at: selected, ...day }))
        .catch((): Day => ({ at: selected, status: 'error', events: [] }))
        .then((day) => {
          // Revoked access must not expose cached events when another date is selected.
          if (day.status !== 'granted') { generation.current++; days.current.clear() }
          else if (startedIn !== generation.current) return undefined
          days.current.set(selected, day)
          return day
        })
        .finally(() => { if (pending.current.get(selected) === read) pending.current.delete(selected) })
      pending.current.set(selected, read)
    }
    const day = await read
    if (mine === seq.current) {
      setLoaded(day)
      if (!day) void load()
    }
  }, [selected])
  useEffect(() => {
    // Keep a same-day refresh in place; never present an old day's actionable events under a new date.
    void load()
    const timer = setInterval(() => void load(), 60_000)
    const focus = () => void load()
    const off = window.yogurt.meetings.onChange(() => void load())
    const offCalendars = window.yogurt.calendar.onChange(() => { generation.current++; days.current.clear(); pending.current.clear(); setLoaded(undefined); void load() })
    window.addEventListener('focus', focus)
    return () => { seq.current++; off(); offCalendars(); clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [load, today, revision])
  const connect = () => void window.yogurt.calendar.connect().then(load, () => setLoaded({ at: selected, status: 'error', events: [] }))
  const chosen = new Date(selected)
  const relativeDay = daysAgo(selected)
  const calendar = loaded?.at === selected ? loaded : days.current.get(selected)
  const scrollKey = `agenda/${selected}`
  const scroll = useScrollMemory<HTMLDivElement>(scrollKey, !!calendar)
  useEffect(() => { lastView = { selected, week: weekAnchor } }, [selected, weekAnchor])
  const events = calendar?.events ?? []
  const primary = pickNext(events, now)
  const defaultEvent = relativeDay === 0 ? events.find(e => e.id === primary) ?? events.find(e => e.start > now) ?? events.at(-1) : events[0]
  const detail = inspected?.at === selected ? events.find(e => e.id === inspected.id) : undefined
  useLayoutEffect(() => {
    if (!defaultEvent || !scroll.current) return
    const key = `${selected}/${jump}`
    if (initialized.current === key) return
    initialized.current = key
    const jumping = lastJump.current !== jump
    lastJump.current = jump
    // Restore manual reading positions; only a fresh day or Today explicitly jumps to the next meeting.
    if (!jumping && rememberedScroll(scrollKey) !== undefined) return
    const row = scroll.current.querySelector<HTMLElement>('[data-agenda-default="true"]')
    if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 16
  }, [calendar, defaultEvent, selected, jump, scrollKey, scroll])
  return <aside className="native-agenda" aria-label={t('Agenda')}>
    <div className="agenda-header">
      <h2>{t('Agenda')}</h2>
      <button className="workspace-button" onClick={() => { const at = shiftDay(Date.now(), 0); setSelected(at); setWeekAnchor(at); setInspected(undefined); setJump(n => n + 1) }}>{t('Today')}</button>
    </div>
    <div className="agenda-navigation">
      <span className="agenda-month">{new Date(weekAnchor).toLocaleDateString(language(), { month: 'long', year: 'numeric' })}</span>
      <button className="workspace-icon" aria-label={t('Previous week')} onClick={() => setWeekAnchor((at) => shiftDay(at, -7))}><ChevronLeft size={15} className="rtl:-scale-x-100" /></button>
      <button className="workspace-icon" aria-label={t('Next week')} onClick={() => setWeekAnchor((at) => shiftDay(at, 7))}><ChevronRight size={15} className="rtl:-scale-x-100" /></button>
    </div>
    <div className="agenda-week" aria-label={t('Choose agenda date')}>
      {weekDates(weekAnchor).map((at) => {
        const d = new Date(at)
        return <button key={at} aria-label={d.toLocaleDateString(language(), { weekday: 'long', month: 'long', day: 'numeric' })}
          aria-pressed={d.toDateString() === chosen.toDateString()} aria-current={d.toDateString() === today ? 'date' : undefined}
          onClick={() => { setSelected(at); setInspected(undefined) }}><span>{d.toLocaleDateString(language(), { weekday: 'narrow' })}</span><b>{d.getDate()}</b></button>
      })}
    </div>
    <div className="agenda-day"><h3>{relativeDay === 0 ? t('Today') : relativeDay === -1 ? t('Tomorrow') : chosen.toLocaleDateString(language(), { weekday: 'long' })}</h3><span>{chosen.toLocaleDateString(language(), { month: 'short', day: 'numeric' })}</span></div>
    <ScrollFade enabled={!!calendar}><div ref={scroll} className="agenda-scroll" data-testid="agenda-scroll">
    <LoadingContent key={selected} pending={!calendar} skeleton={<div className="agenda-events">{[0, 1].map(n => <Event key={n} loading event={{ id: String(n), title: '', url: null, start: selected, end: selected, attendees: [] }} me="" now={now} near={false} initial={false} selected={false} onInspect={() => {}} onStart={onStart} />)}</div>}>
    {calendar && (calendar.status !== 'granted' ? <section className="agenda-status" data-testid={calendar.status === 'error' ? 'calendar-error' : 'calendar-off'}>
        <CalendarDays size={22} aria-hidden="true" />
        <h3>{calendar.status === 'error' ? t("Yogurt couldn't read your calendar") : calendar.status === 'denied' ? t('Calendar access is off') : t('See your meetings here')}</h3>
        <p>{calendar.status === 'error' ? t('Try reading the calendars on this Mac again.') : t('Connect the calendars on this Mac to see your upcoming meetings.')}</p>
        <button className="workspace-button" onClick={calendar.status === 'error' ? () => void load() : connect}>{calendar.status === 'error' ? t('Try again') : calendar.status === 'denied' ? t('Open System Settings') : t('Connect calendar')}</button>
      </section>
      : <div data-testid="coming-up" className="agenda-events">
        {calendar.events.length === 0 ? <div className="agenda-status"><CalendarDays size={18} strokeWidth={1.75} aria-hidden="true" /><h3>{t('No meetings')}</h3><p>{t('Your calendar is clear.')}</p></div>
          : calendar.events.map((event) => <Event key={event.id} event={event} me={me} now={now} near={event.id === primary} initial={event.id === defaultEvent?.id} selected={event.id === detail?.id} onInspect={button => { opener.current = button; setInspected({ at: selected, id: event.id }) }} recording={recording} onStart={onStart} />)}
      </div>)}
    </LoadingContent></div></ScrollFade>
    {calendar?.status === 'granted' && detail && <EventDetails key={detail.id} event={detail} recording={recording} onStart={onStart} now={now} onOpen={onOpen} onClose={closeDetails} opener={opener.current} />}
  </aside>
}

function Event({ event, me, now, near, initial, selected, onInspect, recording, onStart, loading = false }: Pick<Actions, 'recording' | 'onStart'> & {
  loading?: boolean; event: AgendaEvent; me: string; now: number; near: boolean; initial: boolean; selected: boolean; onInspect: (button: HTMLButtonElement) => void
}) {
  const [pending, setPending] = useState(false)
  const phase = eventPhase(event, now)
  const mine = recording?.eventId === event.id
  const takeNotes = () => { setPending(true); void onStart(event.id).finally(() => setPending(false)) }
  return <article className={`agenda-event ${phase}`} data-testid={loading ? "agenda-skeleton" : "event"} data-selected={selected} data-agenda-default={initial}>
    <div className="agenda-time">{loading ? <span className="loading-bar" style={{ width: 45 }} /> : timeOf(event.start)}</div>
    <div className="agenda-event-body">
      <div className="agenda-heading">
        <h3><button disabled={loading} data-testid={loading ? undefined : "event-details"} className="agenda-title" aria-expanded={selected} aria-controls={selected ? "agenda-event-details" : undefined} onClick={e => onInspect(e.currentTarget)}>{loading ? <span className="loading-bar" style={{ width: '85%' }} /> : event.title || t('Meeting')}</button></h3>
      </div>
      {(loading || event.attendees.length > 0) && <p className="agenda-people" title={event.attendees.map((p) => p.name).join(', ')}>{loading ? <span className="loading-bar" style={{ width: '60%' }} /> : peopleSummary(event.attendees, me)}</p>}
      {!loading && (mine || phase === 'live') && <span className="agenda-live">{mine ? recording.paused ? t('Paused') : t('Recording') : t('In progress')}</span>}
      {!mine && phase === 'upcoming' && near && <span className="agenda-live">{t('Starts in {count} min', { count: Math.ceil((event.start - now) / 60_000) })}</span>}
      {!loading && phase === 'live' && !recording && (!event.note || event.note.state === 'prepared') && <div className="agenda-actions">
        <button data-testid="event-start" disabled={pending} className="workspace-button primary agenda-action" onClick={takeNotes}><Mic size={12} aria-hidden="true" />{t('Take notes')}</button>
      </div>}
    </div>
  </article>
}

function EventDetails({ event, recording, onOpen, onStart, now, onClose, opener }: { event: AgendaEvent; now: number; onClose: (restoreFocus?: boolean) => void; opener: HTMLButtonElement | null } & Pick<Actions, 'recording' | 'onOpen' | 'onStart'>) {
  const panel = useRef<HTMLDialogElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const noteId = recording?.eventId === event.id ? recording.id : event.note?.id
  const action = agendaNoteAction(event, recording, now)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const act = async () => {
    setPending(true); setFailed(false)
    try {
      if (action === 'start') await onStart(event.id)
      else if (action === 'open' && noteId) onOpen(noteId)
      else if (action === 'prepare') {
        const result = await window.yogurt.meetings.prepare(event.id, event.start)
        if ('error' in result) throw new Error(result.error)
        onOpen(result.id)
      }
    } catch { setFailed(true) } finally { setPending(false) }
  }
  useAgendaCard(panel, opener, onClose)
  useEffect(() => {
    const el = panel.current!
    const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !opener?.contains(e.target as Node)) onClose(false) }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return
      e.preventDefault(); e.stopPropagation(); onClose()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [onClose, opener])
  const url = event.url?.trim()
  return <dialog ref={panel} id="agenda-event-details" data-testid="event-details-content" className="agenda-inspector" aria-labelledby="agenda-detail-title" onCancel={e => { e.preventDefault(); onClose() }}>
    <i className="agenda-inspector-arrow" aria-hidden="true" />
    <div className="agenda-inspector-content">
    <div className="agenda-inspector-heading"><h3 id="agenda-detail-title" tabIndex={-1}>{event.title || t('Meeting')}</h3>
      <button className="workspace-icon" aria-label={t('Close')} onClick={() => onClose()}><X size={16} aria-hidden="true" /></button>
    </div>
    <div className="agenda-inspector-line agenda-inspector-time"><Clock size={15} aria-hidden="true" /><div>
      <p>{timeOf(event.start)} – {timeOf(event.end)}</p>
      <p className="agenda-inspector-muted">{new Date(event.start).toLocaleDateString(language(), { weekday: 'long', month: 'short', day: 'numeric' })}</p>
    </div></div>
    {event.attendees.length > 0 && <ScrollFade><div ref={scroll} className="agenda-inspector-line agenda-inspector-scroll" data-testid="agenda-detail-scroll"><UsersRound size={15} aria-hidden="true" /><div className="agenda-inspector-people">
      <ul id="agenda-detail-people" aria-label={t('People')}>
        {(expanded ? event.attendees : event.attendees.slice(0, 5)).map((person, i) => <li key={`${person.name}-${i}`} title={person.email || undefined}>{personName(person.name)}{expanded && person.email && person.email !== personName(person.name) && <span>{person.email}</span>}</li>)}
      </ul>
      {!expanded && event.attendees.length > 5 && <button className="agenda-more-people" aria-expanded={false} aria-controls="agenda-detail-people" onClick={() => setExpanded(true)}>{t('and {count} more', { count: event.attendees.length - 5 })}</button>}
    </div></div></ScrollFade>}
    {action === 'start' && <button data-testid="event-open" disabled={pending} className="workspace-button agenda-open-note primary self-start" onClick={() => void act()}><Mic size={13} aria-hidden="true" />{t('Take notes')}</button>}
    {(event.calendar || action && action !== 'start' || url) && <div className="agenda-inspector-footer" data-testid="agenda-detail-footer">
    {event.calendar && <div className="agenda-inspector-line"><CalendarDays size={15} aria-hidden="true" /><p>{event.calendar.name}{event.calendar.source && <span>{event.calendar.source}</span>}</p></div>}
    {(action && action !== 'start' || url) && <div className="agenda-inspector-actions">
    {action && action !== 'start' && <button data-testid="event-open" disabled={pending} className="workspace-button agenda-open-note" title={action === 'open' ? t('Open note') : t('Prepare note')} onClick={() => void act()}><FileText size={13} aria-hidden="true" /><span>{action === 'open' ? t('Open note') : t('Prepare note')}</span></button>}
    {url && <a className="workspace-button agenda-open-note" title={t('Join meeting')} href={url} target="_blank" rel="noreferrer"><span>{t('Join meeting')}</span><ExternalLink size={12} aria-hidden="true" /></a>}
    </div>}
    </div>}
    {failed && <p role="alert" className="text-danger">{t("Yogurt couldn't start the notes. Try again in a moment.")}</p>}
    </div>
  </dialog>
}
