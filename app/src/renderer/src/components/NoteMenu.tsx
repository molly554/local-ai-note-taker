import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, Ellipsis, FolderIcon, Pencil, Trash2 } from 'lucide-react'
import { t } from '../../../shared/i18n'

/**
 * The note's "more" menu beside Share: rename it, add it to folders (folders: that list, shown in the menu's place),
 * or delete it (not while it records)
 */
export function NoteMenu({ recording, savePending, onRename, onDelete, folders, trashed }: { recording: boolean; savePending?: boolean; onRename: () => void; onDelete: () => void; folders?: (close: () => void) => ReactNode; /** in the Trash already: Delete is for good */ trashed?: boolean }) {
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const [inFolders, setInFolders] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) { setInFolders(false); return }
    first.current?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    const list = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]') ?? [])
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  const run = (fn: () => void) => { setOpen(false); fn() }

  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent'
  return (
    <div ref={root} className="relative">
      <button ref={button} data-testid="note-menu-button" aria-haspopup="menu" aria-expanded={!!open} aria-label={t('More')} title={t('More')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')} className="bar-btn grid size-7 place-items-center rounded-md text-muted"><Ellipsis size={17} strokeWidth={1.75} aria-hidden="true" /></button>
      {open && (
        <div data-testid="note-menu" data-pointer={open === 'pointer'} role="menu" aria-label={t('More')} onKeyDown={onKey}
          className="menu-entry absolute end-0 top-full z-30 mt-2 w-60 rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
          {inFolders && folders ? folders(() => { setOpen(false); button.current?.focus() }) : <>
          <button ref={first} role="menuitem" data-testid="note-rename" onClick={() => run(onRename)} className={row}>
            <Pencil size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{t('Rename')}
          </button>
          {folders && <button role="menuitem" data-testid="note-add-to-folder" aria-haspopup="menu" onClick={() => {
            setInFolders(true)
            // the list takes the menu's place: keyboard focus moves to its first folder
            requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus())
          }} className={row}>
            <FolderIcon size={15} aria-hidden="true" className="text-muted" /><span className="flex-1">{t('Add to folder')}</span><ChevronRight size={14} aria-hidden="true" className="text-muted rtl:-scale-x-100" />
          </button>}
          <button role="menuitem" data-testid="note-delete" disabled={recording || savePending} onClick={() => run(() => { button.current?.focus(); onDelete() })} className={`${row} text-danger`}>
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="flex flex-col">
              {trashed ? t('Delete forever') : t('Delete note')}
              {recording && <span className="text-xs text-muted">{t('Stop the recording first')}</span>}
              {savePending && <span className="text-xs text-muted">{t('Finish saving first')}</span>}
            </span>
          </button>
          </>}
        </div>
      )}
    </div>
  )
}
