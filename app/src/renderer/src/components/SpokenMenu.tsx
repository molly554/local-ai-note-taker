import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Info, Languages } from 'lucide-react'
import { SPOKEN_LANGUAGES, WHISPER_LANGUAGES, autonym, type Spoken } from '../../../shared/spoken'
import { t } from '../../../shared/i18n'

/** the names shown on the chip and in Settings */
export const spokenName = (s: Spoken): string => (s === 'en' ? t('English') : s === 'multi' ? t('Multi-language') : autonym(s))

/**
 * The spoken language under the note's bar, beside the mic, as a menu: English only (faster, nothing guessed),
 * Multi-language, or one of the other languages by name. Choosing counts for the recording going on from its next
 * words, and is remembered for the next ones.
 */
export function SpokenMenu() {
  const [spoken, setSpoken] = useState<Spoken>()
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Settings can change it too: read again when the window comes back
    const load = () => void window.yogurt.settings.get().then((p) => setSpoken(p.spoken)).catch(() => {})
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  useEffect(() => {
    if (!open) return
    const q = (sel: string) => root.current?.querySelector<HTMLButtonElement>(sel)
    // the checked row first (one selector list would give whichever comes first on the page)
    ;(q('[role="menuitemradio"][aria-checked="true"]') ?? q('[role="menuitemradio"]'))?.focus()
  }, [open])

  const choose = (v: Spoken) => {
    setOpen(false); button.current?.focus()
    setSpoken(v)
    void window.yogurt.settings.setSpoken(v).catch(() => {})
  }
  const onKey = (e: KeyboardEvent) => {
    const list = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }

  if (!spoken) return null
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const tick = (on: boolean) => <Check size={15} aria-hidden="true" className={`ms-auto shrink-0 ${on ? '' : 'invisible'}`} />
  const about = t('Yogurt listens for the language being spoken. Pick it for meetings that are not in English.')
  return (
    <div ref={root} className="relative flex min-w-0 items-center">
      <button ref={button} data-testid="spoken-chip" aria-haspopup="menu" aria-expanded={!!open} title={t('Spoken language')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        className="bar-btn flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:text-ink aria-expanded:text-ink">
        <Languages size={11} aria-hidden="true" className="shrink-0" />
        <span data-testid="spoken-name" className="truncate">{spokenName(spoken)}</span>
        <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
      </button>
      {open && (
        <div data-testid="spoken-menu" data-pointer={open === 'pointer'} data-anchor="bottom-start" role="menu" aria-label={t('Spoken language')} onKeyDown={onKey}
          className="menu-entry absolute bottom-full start-0 z-30 mb-2 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <button role="menuitemradio" aria-checked={spoken === 'en'} data-testid="spoken-en" onClick={() => choose('en')} className={row}>
            <span className="flex min-w-0 flex-col">
              <span>{t('English only')}</span>
              <span className="text-xs text-muted">{t('Highest quality')}</span>
            </span>
            {tick(spoken === 'en')}
          </button>
          <button role="menuitemradio" aria-checked={spoken === 'multi'} data-testid="spoken-multi" onClick={() => choose('multi')} className={row}>
            <span className="flex min-w-0 flex-col">
              <span>{t('Multi-language')}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                {t('{count} languages supported', { count: WHISPER_LANGUAGES })}
                <span data-testid="spoken-multi-info" title={about} aria-label={about}><Info size={12} aria-hidden="true" /></span>
              </span>
            </span>
            {tick(spoken === 'multi')}
          </button>
          {/* each in its own name: told which language it is, whisper guesses nothing */}
          {SPOKEN_LANGUAGES.map((code) => (
            <button key={code} role="menuitemradio" aria-checked={spoken === code} data-testid={`spoken-${code}`} lang={code} onClick={() => choose(code)} className={row}>
              <span>{autonym(code)}</span>
              {tick(spoken === code)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
