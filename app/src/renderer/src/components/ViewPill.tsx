import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Check, Ellipsis, RotateCcw } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { TEMPLATES, type Template } from '../../../shared/templates'
import { templateName } from './SummarySettings'

/**
 * Generation actions remain separate from navigation: writing the Summary again as it is, or again with another
 * template, which then is this meeting's own.
 */
export function SummaryActions({ hasSummary, canWriteAgain, onWriteAgain, template, onTemplate, menuButton }: {
  /** the enhanced notes are done (not waiting or being written) */
  hasSummary: boolean
  canWriteAgain: boolean
  onWriteAgain: () => void
  /** the template this meeting's Summary is written with */
  template: Template
  /** another template was picked: the Summary is written again with it */
  onTemplate: (template: Template) => void
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
  // writing started while the menu was open (new people, or a choice just made): its entries all go grey, and a
  // greyed entry holding focus hears no keys, Escape included. The menu closes instead.
  const could = useRef(canWriteAgain)
  useEffect(() => {
    if (could.current && !canWriteAgain) setOpen(false)
    could.current = canWriteAgain
  }, [canWriteAgain])
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setOpen(false); menuButton.current?.focus(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    // up and down go round the entries that can be chosen
    e.preventDefault()
    const entries = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = entries.indexOf(document.activeElement as HTMLButtonElement)
    entries[(at + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus()
  }
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent'
  return (
    <div ref={root} className="note-summary-actions relative">
      <button ref={menuButton} data-testid="note-view-menu" aria-haspopup="menu" aria-expanded={!!open} aria-label={t('Summary actions')} title={action}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')} className="note-view-menu">
        <Ellipsis size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" data-testid="note-view-menu-list" data-pointer={open === 'pointer'} data-anchor="end" aria-label={t('Summary')} onKeyDown={keys}
          className="menu-entry absolute end-0 top-full z-30 mt-2 w-56 rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <button ref={item} role="menuitem" data-testid="note-write-again" disabled={!canWriteAgain} onClick={() => { setOpen(false); onWriteAgain() }} className={row}>
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" className="text-muted" />{action}
          </button>
          <div role="group" aria-label={t('Template')} data-testid="note-templates" className="mt-1 border-t border-line pt-1">
            <p aria-hidden="true" className="px-3 pb-0.5 pt-1.5 text-xs text-muted">{t('Template')}</p>
            {TEMPLATES.map((v) => (
              // choosing the one it has already writes nothing again
              <button key={v} role="menuitemradio" aria-checked={v === template} data-testid={`note-template-${v}`} disabled={!canWriteAgain}
                onClick={() => { setOpen(false); if (v !== template) onTemplate(v) }} className={row}>
                <span className="grid w-[15px] shrink-0 place-items-center">{v === template && <Check size={15} strokeWidth={2} aria-hidden="true" className="text-[var(--accent)]" />}</span>
                {templateName(v)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
