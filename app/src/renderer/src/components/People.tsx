import { attendeePrivacy, emailName } from '../../../shared/people'
import { toasts } from './TrashToast'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useNotePopover } from '../useNotePopover'
import { Lock, Pencil, Plus, Users, X } from 'lucide-react'
import type { Meeting, Person } from '../../../shared/types'
import { t } from '../../../shared/i18n'

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const first = (name: string) => personName(name).split(/\s+/)[0] ?? name

/** An address can identify someone without turning the visible name into an invitation chip. */
export function personName(name: string): string {
  const person = parsePerson(name)
  if (!person?.email || person.name !== person.email) return person?.name ?? name
  return emailName(person.email)
}

/** Accept a display name, an email address, or a name followed by an address in angle brackets. */
export function parsePerson(raw: string): Person | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const email = /<?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?/.exec(text)
  if (!email) return { name: text, email: null }
  const name = text.replace(email[0], '').replace(/[,;]/g, ' ').trim()
  return { name: name || email[1], email: email[1] }
}

/** Compact labels show up to three first names, without counting the person themself. */
export function peopleSummary(people: Person[], me: string, limit = 3): string {
  const others = people.filter((p) => !same(p.name, me))
  if (!others.length) return t('Me')
  const names = others.slice(0, limit).map((p) => first(p.name)).reduce((a, b) => t('{a}, {b}', { a, b }))
  return others.length > limit ? t('{name} + {more}', { name: names, more: others.length - limit }) : names
}

/** The header keeps room for the date and folder beside two names. */
export function peopleChipSummary(people: Person[], me: string): string {
  return people.some(p => !same(p.name, me)) ? peopleSummary(people, me, 2) : t('Add attendees')
}

/** One settings read per surface, shared by all of its compact attendee labels. */
export function useMyName() {
  const [me, setMe] = useState('')
  useEffect(() => { void window.yogurt.settings.get().then((s) => setMe(s.myName || s.macName)) }, [])
  return me
}

/** Attendee membership and inline person editing, separate from the calendar details. */
export function People({ m }: { m: Meeting }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const me = useMyName()
  const chip = useRef<HTMLButtonElement>(null)
  const close = useCallback((restore = true) => { setOpen(false); if (restore) chip.current?.focus({ preventScroll: true }) }, [])

  return (
    <div className="relative">
      <button ref={chip} data-testid="note-attendees" aria-haspopup="dialog" aria-expanded={!!open} onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        title={m.attendees.map(a => a.email ? `${a.name} <${a.email}>` : a.name).join(', ') || undefined}
        className="note-chip flex items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
        <span data-testid="note-attendees-summary" className="flex items-center gap-1.5"><Users size={14} strokeWidth={1.75} aria-hidden="true" />{peopleChipSummary(m.attendees, me)}</span>
      </button>
      {open && <Card m={m} me={me} pointer={open === 'pointer'} chip={chip} onClose={close} />}
    </div>
  )
}

function Card({ m, me, pointer, chip, onClose }: { m: Meeting; me: string; pointer: boolean; chip: RefObject<HTMLButtonElement | null>; onClose: (restore?: boolean) => void }) {
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(() => !m.attendees.some(p => !same(p.name, me)))
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  useNotePopover(card, chip, onClose)
  useEffect(() => { if (adding) input.current?.focus({ preventScroll: true }) }, [adding])
  const save = async (people: Person[]) => {
    try { await window.yogurt.meetings.setAttendees(m.id, people); return true }
    catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }); return false }
  }
  const add = async () => {
    const p = parsePerson(text)
    if (!p) return
    // already there: nothing to add
    if (m.attendees.some((a) => same(a.name, p.name) || (p.email && a.email && same(a.email, p.email)))) return
    if (await save([...m.attendees, p])) setText('')
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  // the person themself first, marked; an invite that lists them too shows them once
  const others = m.attendees.map((p, i) => ({ p, i })).filter(({ p }) => !same(p.name, me))

  return (
    <div ref={card} data-testid="people-card" data-pointer={pointer} data-anchor="start" role="dialog" aria-label={t('People')} onKeyDown={key}
      className="people-card menu-entry absolute start-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-48px))] rounded-lg border border-line bg-float text-ink shadow-[var(--shadow)]">
      <ul data-testid="people-list" className="people-list max-h-64 overflow-y-auto p-1.5">
        <Row name={me || t('Me')} email={m.attendees.find(p => same(p.name, me))?.email} mine />
        {others.map(({ p, i }) => (
          <Row key={p.email || i} name={personName(p.name)} email={p.email} onRename={name => window.yogurt.meetings.renameAttendee(m.id, i, name, p)} onRemove={() => void save(m.attendees.filter((_, j) => j !== i))} />
        ))}
      </ul>
      <div className={`border-t border-line ${adding ? 'p-3' : ''}`}>
        <button data-testid="people-add-open" onClick={() => { setAdding(true); input.current?.focus() }} className={`flex w-full items-center gap-2 text-start text-[13px] text-muted ${adding ? 'mb-2' : 'h-11 px-4 hover:bg-card'}`}><Plus size={14} aria-hidden="true" />{t('Add an attendee')}</button>
        {adding && <div className="people-add-field flex h-9 items-center rounded-md border border-line bg-card px-2.5">
          <input ref={input} data-testid="people-add" value={text} onChange={(e) => setText(e.target.value)} maxLength={200}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add() } }}
            placeholder={t('Name or email')} aria-label={t('Add an attendee')} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
        </div>}
      {attendeePrivacy(focused, text) && <p data-testid="people-private" className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted">
        <Lock size={12} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{t('Nothing is sent. This is only for your notes.')}</span>
      </p>}
      </div>
    </div>
  )
}

function Row({ name, email, mine, onRemove, onRename }: { name: string; email?: string | null; mine?: boolean; onRemove?: () => void; onRename?: (name: string) => Promise<boolean> }) {
  const nameButton = useRef<HTMLButtonElement>(null)
  const stopEditing = () => { setEditing(false); requestAnimationFrame(() => nameButton.current?.focus()) }
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name), [saving, setSaving] = useState(false)
  const save = async () => {
    if (!draft.trim() || saving) return
    setSaving(true)
    try {
      if (!await onRename?.(draft)) throw new Error('Attendee no longer available')
      stopEditing()
    } catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }) }
    finally { setSaving(false) }
  }
  return (
    <li data-testid="people-row" data-me={mine ? '' : undefined} className={`person-row flex ${email ? 'min-h-[52px]' : 'min-h-10'} items-center gap-2 rounded-md px-2.5 py-1.5`}>
      <div className="min-w-0 flex-1 text-[13px]" title={email ?? undefined}>
        {editing ? <input data-testid="people-rename" autoFocus value={draft} disabled={saving} maxLength={200} aria-label={t('Rename')} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEditing() } }} className="w-full rounded border border-line bg-card px-1 py-0.5" />
          : onRename ? <button ref={nameButton} data-testid="people-name" title={t('Rename')} className="block max-w-full truncate text-start" onClick={() => { setDraft(name); setEditing(true) }}>{name}</button>
          : <span>{name}{mine && <span className="text-muted"> {t('(me)')}</span>}</span>}
        {email && <span data-testid="people-email" className="block break-words text-xs leading-[17px] text-muted">{email}</span>}
      </div>
      {onRename && !editing && <button data-testid="people-edit" aria-label={t('Rename')} title={t('Rename')} onClick={() => { setDraft(name); setEditing(true) }} className="person-remove grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-[var(--line)] hover:text-ink"><Pencil size={14} strokeWidth={1.75} aria-hidden="true" /></button>}
      {onRemove && (
        <button data-testid="people-remove" onClick={onRemove} aria-label={t('Remove {name}', { name })} title={t('Remove')}
          className="person-remove grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-[var(--line)] hover:text-ink">
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

