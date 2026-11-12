import { FolderGlyph } from './FolderAppearance'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, FolderIcon, Plus, X } from 'lucide-react'
import type { Folder } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { useFolders } from '../folders'
import { toasts } from './TrashToast'

export type FolderSuggestion = { folder: Folder; dismiss: () => void }

/**
 * Every folder with a check on the ones this meeting is in; a click puts it in or takes it out, and the list stays
 * open for the next. New folder… asks for a name (onNew), and the meeting goes into it.
 */
export function FolderPicker({ meetingId, onNew, testId }: { meetingId: string; onNew: () => void; testId: string }) {
  const all = useFolders()
  const mine = useFolders(meetingId)
  // shown at once while main catches up, so a quick second click undoes the first
  const [pending, setPending] = useState<Record<string, boolean>>({})
  useEffect(() => { setPending({}) }, [mine])
  const inIt = (id: string) => pending[id] ?? !!mine?.some((s) => s.id === id)
  const toggle = (id: string) => {
    const on = !inIt(id)
    setPending((p) => ({ ...p, [id]: on }))
    void (on ? window.yogurt.folders.add(id, meetingId) : window.yogurt.folders.remove(id, meetingId))
  }
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  return <div data-testid={testId} role="group" aria-label={t('Folders')}>
    {all?.map((s) => <button key={s.id} role="menuitemcheckbox" aria-checked={inIt(s.id)} data-testid="folder-option" onClick={() => toggle(s.id)} className={row}>
      <FolderGlyph appearance={s} size={15} />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      {inIt(s.id) && <Check size={15} aria-hidden="true" className="shrink-0 text-accent" />}
    </button>)}
    <button role="menuitem" data-testid="folder-new" onClick={onNew} className={`${row} ${all?.length ? 'folder-picker-new' : ''}`}>
      <Plus size={15} aria-hidden="true" className="shrink-0 text-muted" />{t('New folder…')}
    </button>
  </div>
}

/**
 * The note's folders chip, beside its date and people: the folders it is in, or Add to folder. It opens the same list
 * as the note's menu.
 */
export function FolderChip({ meetingId, onNew, suggestion: manualSuggestion }: { meetingId: string; onNew: () => void; suggestion?: FolderSuggestion }) {
  const [automatic, setAutomatic] = useState<Folder | null>(null)
  useEffect(() => {
    setAutomatic(null)
    let seq = 0
    const load = () => {
      const current = ++seq
      void window.yogurt.folders.suggestion(meetingId).then(folder => { if (current === seq) setAutomatic(folder) }, () => {})
    }
    load()
    const off = window.yogurt.folders.onChange(load), offMeetings = window.yogurt.meetings.onChange(load)
    return () => { seq++; off(); offMeetings() }
  }, [meetingId])
  const suggestion = manualSuggestion ?? (automatic ? { folder: automatic, dismiss: () => setAutomatic(null) } : undefined)
  const folders = useFolders(meetingId)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const root = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (suggestion && folders?.some((folder) => folder.id === suggestion.folder.id)) suggestion.dismiss()
  }, [folders, suggestion])
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const key = (e: KeyboardEvent) => {
    const list = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]') ?? [])
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); chip.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  const label = !folders?.length ? t('Add to folder') : folders.length === 1 ? folders[0].name : t('{name} + {more}', { name: folders[0].name, more: folders.length - 1 })
  const dismissSuggestion = async () => {
    if (!manualSuggestion) {
      try { await window.yogurt.folders.dismissSuggestion(meetingId) }
      catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }); return }
    }
    toasts.close(`folder-suggestion-${meetingId}`); suggestion?.dismiss()
    requestAnimationFrame(() => { if (document.activeElement === document.body) chip.current?.focus({ preventScroll: true }) })
  }
  const confirmSuggestion = async () => {
    if (!suggestion || adding) return
    const folderId = suggestion.folder.id
    setAdding(true); toasts.close(`folder-suggestion-${meetingId}`)
    try {
      await window.yogurt.folders.add(folderId, meetingId)
      // The folder may have disappeared since the proposal; never show a silent no-op as accepted.
      if (!(await window.yogurt.folders.of(meetingId)).some((folder) => folder.id === folderId)) throw new Error('Folder not added')
      await dismissSuggestion()
    } catch {
      toasts.add({ id: `folder-suggestion-${meetingId}`, data: { testId: 'folder-suggestion-error' }, title: t("Yogurt couldn't add this note to the folder. Try again.") })
    } finally { setAdding(false) }
  }
  if (suggestion && !folders?.some((folder) => folder.id === suggestion.folder.id)) return <div data-testid="folder-suggestion" role="group" aria-label={t('Add to folder')}
    className={`note-chip flex max-w-64 items-center gap-1.5 rounded-md border border-line ps-2.5 pe-1 text-[13px] text-muted ${!manualSuggestion ? 'note-folder-proposal' : ''}`}>
    <FolderGlyph appearance={suggestion.folder} size={14} />
    <span className="min-w-0 truncate" title={t('Add to {name}?', { name: suggestion.folder.name })}>{manualSuggestion ? t('Add to {name}?', { name: suggestion.folder.name }) : <>{suggestion.folder.name}?</>}</span>
    <button data-testid="folder-suggestion-confirm" className="workspace-icon" disabled={adding} onClick={() => void confirmSuggestion()} aria-label={t('Add to folder')} title={t('Add to folder')}><Check size={15} aria-hidden="true" /></button>
    <button data-testid="folder-suggestion-cancel" className="workspace-icon" disabled={adding} onClick={() => void dismissSuggestion()} aria-label={t('Cancel')} title={t('Cancel')}><X size={15} aria-hidden="true" /></button>
  </div>
  return (
    <div ref={root} className="relative">
      <button ref={chip} data-testid="note-folders" aria-haspopup="menu" aria-expanded={!!open} onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        title={folders?.map((s) => s.name).join(', ') || undefined}
        className="note-chip flex max-w-64 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-muted">
        {folders?.length === 1 ? <FolderGlyph appearance={folders[0]} size={14} /> : <FolderIcon size={14} aria-hidden="true" className="shrink-0" />}<span data-testid="note-folders-summary" className="truncate">{label}</span>
      </button>
      {open && <div data-testid="folder-menu" data-pointer={open === 'pointer'} data-anchor="start" role="menu" aria-label={t('Add to folder')} onKeyDown={key}
        className="menu-entry absolute start-0 top-full z-30 mt-2 max-h-80 w-60 overflow-y-auto rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
        <FolderPicker testId="folder-chip-list" meetingId={meetingId} onNew={() => { setOpen(false); onNew() }} />
      </div>}
    </div>
  )
}
