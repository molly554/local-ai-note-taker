import { useEffect, useRef, useState, type RefObject } from 'react'
import { Ellipsis, RotateCcw } from 'lucide-react'
import { t } from '../../../shared/i18n'

/**
 * Generation actions remain separate from navigation.
 */
export function SummaryActions({ hasSummary, canWriteAgain, onWriteAgain, menuButton }: {
  /** the enhanced notes are done (not waiting or being written) */
  hasSummary: boolean
  canWriteAgain: boolean
  onWriteAgain: () => void
  menuButton: RefObject<HTMLButtonElement | null>
}) {
  const action = hasSummary ? t('Regenerate summary') : t('Generate summary')
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const root = useRef<HTMLDivElement>(null)
  const item = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    item.current?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  return (
    <div ref={root} className="note-summary-actions relative">
      <button ref={menuButton} data-testid="note-view-menu" aria-haspopup="menu" aria-expanded={!!open} aria-label={t('Summary actions')} title={action}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')} className="note-view-menu">
        <Ellipsis size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" data-testid="note-view-menu-list" data-pointer={open === 'pointer'} data-anchor="end" aria-label={t('Summary')}
          onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setOpen(false); menuButton.current?.focus() } }}
          className="menu-entry absolute end-0 top-full z-30 mt-2 w-52 rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <button ref={item} role="menuitem" data-testid="note-write-again" disabled={!canWriteAgain} onClick={() => { setOpen(false); onWriteAgain() }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent">
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{action}
          </button>
        </div>
      )}
    </div>
  )
}
