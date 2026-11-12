import { LoadingContent } from '../components/LoadingContent'
import { Mic } from '../components/Icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, FileText, Users } from 'lucide-react'
import type { MeetingCard } from '../../../shared/types'
import { useScrollMemory } from '../useScrollMemory'
import { loadUpTo } from '../paging'
import { t } from '../../../shared/i18n'
import { dayLabel, timeOf, useDay } from '../dates'
import { useLanguage } from '../i18n'
import { toasts } from '../components/TrashToast'
import { MeetingRow } from '../components/MeetingRow'
import { SpokenSelect } from '../components/SpokenSetting'
import { Agenda } from '../components/Agenda'
import { MEETING_DRAG } from '../folders'
import { peopleSummary, useMyName } from '../components/People'

const PAGE = 40
const loadedCounts = new Map<string, number>()

/** The workspace, backed by the existing meeting and calendar bridge. */
export function Home({ open, openFolder }: { open: (id: string) => void; openFolder?: (id: string) => void }) {
  const past = usePastNotes()
  const day = useDay()
  const recording = past.cards?.find((c) => c.state === 'recording')
  const [calendarRevision, setCalendarRevision] = useState(0)
  const start = async (eventId: string | null) => {
    toasts.close('home-message')
    const r = await window.yogurt.meetings.start(eventId).catch(() => ({ error: 'failed' as const }))
    if (!('error' in r)) return
    if (r.error === 'gone') setCalendarRevision((revision) => revision + 1)
    toasts.add({ id: 'home-message', data: { testId: 'home-message' }, title: r.error === 'gone' ? t('That meeting is no longer on your calendar.') : t("Yogurt couldn't start the notes. Try again in a moment.") })
  }
  const noMeetings = past.cards?.length === 0
  const calendar = window.yogurt.capabilities.calendar
  return <div data-testid="home" className={calendar ? 'native-home' : 'native-home no-agenda'}>
    <div className="home-toolbar-action no-drag">
      {/* with no meetings yet the one button is in the middle of the page, beside the language it will listen for */}
      {!recording && past.cards && !noMeetings && <button data-testid="new-note" onClick={() => start(null)} className="workspace-button primary"><Mic size={14} aria-hidden="true" />{t('Start recording')}</button>}
    </div>
    <div className="native-library" ref={past.setRoot}>
      <h1>{t('Your meetings')}</h1>
      <LoadingContent pending={!past.cards} testId="meetings-loading" skeleton={<MeetingListLoading />} className="library-load">{noMeetings ? <section data-testid="past-empty" className="library-empty empty-state"><div className="empty-state-content">
        <div className="empty-tile"><FileText size={28} strokeWidth={1.5} aria-hidden="true" /></div><h2>{t('Your notes will show up here')}</h2>
        <p>{t('Start recording, add a few notes, and Yogurt writes the rest when you stop.')}</p>
        {/* the first step, where the eye already is: the language to listen for, which decides whether the words come out right, and the button */}
        {!recording && <div data-testid="empty-guide" className="empty-guide no-drag">
          <label htmlFor="home-spoken" className="empty-guide-language"><span>{t('Spoken language')}</span><SpokenSelect id="home-spoken" testId="home-spoken" /></label>
          <button data-testid="new-note" onClick={() => start(null)} className="workspace-button primary"><Mic size={14} aria-hidden="true" />{t('Start recording')}</button>
        </div>}
      </div></section> : <PastNotes cards={past.cards ?? []} day={day} more={past.more} sentinel={past.setSentinel} onOpen={open} openFolder={openFolder} />}</LoadingContent>
    </div>
    {calendar && <Agenda revision={calendarRevision} recording={recording} onStart={start} onOpen={open} />}
  </div>
}

/**
 * Past notes a page at a time: the next page loads as the end of the list comes near. Any change to a meeting
 * reloads what is already shown (one query, however far down the person scrolled). folder: only its meetings (a
 * folder's page), which also follow every change to folders.
 */
export function usePastNotes(folder?: string) {
  const [cards, setCards] = useState<MeetingCard[]>()
  const [more, setMore] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const memoryKey = folder ? `folder/${folder}` : 'meetings'
  const scroll = useScrollMemory<HTMLDivElement>(memoryKey, !!cards)
  const attachRoot = useCallback((el: HTMLDivElement | null) => { scroll.current = el; setRoot(el) }, [scroll])
  const shown = useRef(loadedCounts.get(memoryKey) ?? 0)
  const loading = useRef(false)
  const seq = useRef(0)

  const reload = useCallback(() => {
    const mine = ++seq.current
    // however far down the person scrolled, in steps (one call to main is capped)
    void loadUpTo((o) => window.yogurt.meetings.cards({ ...o, ...(folder ? { folder } : {}) }), shown.current, PAGE).then(({ cards: list, more }) => {
      if (mine !== seq.current) return
      shown.current = list.length; loadedCounts.set(memoryKey, list.length); setCards(list); setMore(more)
    })
  }, [folder])
  useEffect(() => {
    reload()
    let timer: ReturnType<typeof setTimeout> | undefined
    // notes being written change meetings often: one reload for a burst
    const later = () => { clearTimeout(timer); timer = setTimeout(reload, 150) }
    const off = window.yogurt.meetings.onChange(later)
    const offFolders = window.yogurt.folders.onChange(later)
    return () => { off(); offFolders(); clearTimeout(timer) }
  }, [reload, folder])

  const next = useCallback(() => {
    if (loading.current || !cards?.length) return
    loading.current = true
    const last = cards[cards.length - 1]
    const mine = seq.current
    void window.yogurt.meetings.cards({ limit: PAGE, before: { at: last.startedAt, id: last.id }, ...(folder ? { folder } : {}) }).then((page) => {
      loading.current = false
      if (mine !== seq.current) return
      setCards((cur) => {
        const have = new Set(cur?.map((c) => c.id))
        const all = [...(cur ?? []), ...page.filter((c) => !have.has(c.id))]
        shown.current = all.length; loadedCounts.set(memoryKey, all.length)
        return all
      })
      setMore(page.length === PAGE)
    })
  }, [cards, folder])

  useEffect(() => {
    if (!sentinel || !root || !more) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) next() }, { root, rootMargin: '800px 0px' })
    io.observe(sentinel)
    return () => io.disconnect()
  }, [sentinel, root, more, next])

  return { cards, more, setRoot: attachRoot, setSentinel }
}

/** Delete on a row moves the meeting to the Trash at once (Undo in the note at the bottom) */
export function PastNotes({ cards, day, more, sentinel, onOpen, openFolder, showFolders = true, loading = false }: { loading?: boolean; cards: MeetingCard[]; day: string; more: boolean; sentinel: (el: HTMLDivElement | null) => void; onOpen: (id: string) => void; openFolder?: (id: string) => void; showFolders?: boolean }) {
  const lang = useLanguage()
  const me = useMyName()
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; cards: MeetingCard[] }> = []
    for (const c of cards) {
      const key = new Date(c.startedAt).toDateString()
      if (out.at(-1)?.key === key) out.at(-1)!.cards.push(c)
      else out.push({ key, label: dayLabel(c.startedAt, { weekday: true }), cards: [c] })
    }
    return out
  }, [cards, day, lang])
  return <section aria-label={t('Saved meetings')}>
    {days.map((group) => <div className="native-meeting-day" key={group.key}>
      <h2 data-testid={loading ? undefined : "past-day"}>{loading ? <span className="loading-bar" style={{ width: 48 }} /> : group.label}</h2>
      <ul>{group.cards.map((meeting) => loading ? <li className="native-meeting-row" key={meeting.id}><PastCard c={meeting} onOpen={onOpen} me="" showFolders={showFolders} loading /></li> : <MeetingRow key={meeting.id} id={meeting.id} recording={meeting.state === 'recording'}>
        <PastCard c={meeting} onOpen={onOpen} openFolder={openFolder} me={me} showFolders={showFolders} />
      </MeetingRow>)}</ul>
    </div>)}
    {more && <div data-testid="past-more" ref={sentinel} className="h-8" aria-hidden="true" />}
  </section>
}

/** when: in place of the time (the Trash shows the day); fixed: not dragged onto folders */
export function PastCard({ c, onOpen, openFolder, when, fixed, me, showFolders = true, loading = false }: { loading?: boolean; c: MeetingCard; onOpen: (id: string) => void; openFolder?: (id: string) => void; when?: string; fixed?: boolean; me: string; showFolders?: boolean }) {
  const recording = c.state === 'recording'
  const minutes = (c.state === 'done' || c.state === 'stopped') && c.endedAt != null
    ? Math.max(1, Math.round((c.durationMs ?? (c.endedAt - c.startedAt)) / 60_000)) : null
  const initials = c.attendees[0]?.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join('').toLocaleUpperCase()
  // dragged onto a folder in the sidebar, it goes into that folder
  return <button data-testid={loading ? undefined : "past-note"} disabled={loading} draggable={!fixed && !loading} onDragStart={fixed ? undefined : (e) => {
    e.dataTransfer.setData(MEETING_DRAG, c.id)
    e.dataTransfer.effectAllowed = 'link'
    const preview = document.createElement('div')
    preview.className = 'meeting-drag-preview'
    preview.setAttribute('aria-hidden', 'true')
    preview.append(e.currentTarget.querySelector('.meeting-identity')!.cloneNode(true), e.currentTarget.querySelector('.meeting-description strong')!.cloneNode(true))
    document.body.append(preview)
    e.dataTransfer.setDragImage(preview, 24, 24)
    // The native drag keeps its snapshot after this frame; no duplicate row stays in the page.
    requestAnimationFrame(() => preview.remove())
  }}
    onClick={() => onOpen(c.id)} className="native-meeting-link">
    <span className="meeting-content">
    <span className={`meeting-identity ${recording ? 'recording' : ''}`} aria-hidden="true">{loading ? null : recording ? <Mic size={16} /> : c.attendees.length > 1 ? <Users size={16} /> : initials || <FileText size={16} />}</span>
    <span className="meeting-description"><strong>{loading ? <span className="loading-bar" style={{ width: c.title.length * 6, maxWidth: '85%' }} /> : c.title}</strong><span data-testid={loading ? undefined : "past-note-attendees"} title={c.attendees.map((p) => p.name).join(', ') || undefined}>{loading ? <span className="loading-bar" style={{ width: 110 }} /> : c.attendees.length ? peopleSummary(c.attendees, me) : t('Personal notes')}</span>
    </span>
    {showFolders && !!c.folders?.length && <span className="meeting-folders" data-testid={loading ? undefined : "past-note-folders"}>
      {c.folders.map(folder => <span className="meeting-folder-pill" data-testid={loading ? undefined : "past-note-folder"} data-folder-color={folder.color} data-opens={!!openFolder && !loading} title={folder.name} key={folder.id}
        // a pill inside the row's button: mouse shortcut to the folder; keyboard reaches folders from the sidebar
        onClick={openFolder && !loading ? (e) => { e.stopPropagation(); openFolder(folder.id) } : undefined}>
        <span className="meeting-folder-dot" aria-hidden="true" /><span className="meeting-folder-name">{loading ? <span className="loading-bar" style={{ width: 46 }} /> : folder.name}</span>
      </span>)}
    </span>}
    </span>
    <span className="meeting-meta row-swap-meta">{recording ? <span className="meeting-live"><Circle size={6} fill="currentColor" />{c.paused ? t('Paused') : t('Recording')}</span> : <><time>{loading ? <span className="loading-bar" style={{ width: 45 }} /> : when ?? timeOf(c.startedAt)}</time>{minutes != null && <small data-testid="past-note-duration">{loading ? <span className="loading-bar" style={{ width: 26 }} /> : t('{count} min', { count: minutes })}</small>}</>}</span>
  </button>
}

/** The real row and date-group layout, with representative line lengths rather than viewport-wide bars. */
export function MeetingListLoading({ grouped = true, showFolders = true }: { grouped?: boolean; showFolders?: boolean }) {
  const cards: MeetingCard[] = Array.from({ length: 5 }, (_, n) => ({
    id: `loading-${n}`, title: ['Weekly planning', 'Design and audio review', 'Team standup'][n % 3],
    state: 'done', preview: '', eventId: null, app: null, language: null, titleSource: 'user', startedAt: new Date(2026, 0, n < 3 ? 2 : 1).getTime(), endedAt: 1, durationMs: 120000,
    attendees: [], folders: n % 2 ? [{ id: 'loading-folder', name: '', color: 'violet', icon: 'folder', count: 0 }] : [],
  }))
  return grouped ? <PastNotes cards={cards} day="" more={false} sentinel={() => {}} onOpen={() => {}} showFolders={showFolders} loading />
    : <ul>{cards.map(c => <li className="native-meeting-row trash-row" key={c.id}><PastCard c={c} onOpen={() => {}} me="" loading /></li>)}</ul>
}
