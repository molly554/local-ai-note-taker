import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Info, Mic } from 'lucide-react'
import { Pause } from './Icons'
import type { MicsView } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { Swap } from './Swap'

const autoInfo = () => osWords({ mac: t('Uses the microphone your Mac is set to'), other: t('Uses the microphone your computer is set to') })

/** while the menu is open, mics plugged in or out show up this soon */
const OPEN_REFRESH_MS = 1500
/** while recording, the mic in use is read again this often (the Mac's sound settings can change Auto's) */
const RECORDING_REFRESH_MS = 15_000
/** how long the note about a mic that went away stays */
const FELL_BACK_MS = 8000

/**
 * The mic under the note's bar, as a menu: Auto (the mic the Mac is set to) or any mic on this Mac, the one in use checked.
 * Choosing switches the recording without stopping it, and is remembered for the next one.
 */
export function MicMenu({ recording, paused }: { recording: boolean; paused?: boolean }) {
  const [view, setView] = useState<MicsView>()
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  /** the mic that went away, for the note saying Auto took over */
  const [lost, setLost] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const shown = useRef<MicsView | undefined>(undefined)
  const load = useCallback(() => window.yogurt.audio.mics().then((v) => { shown.current = v; setView(v) }).catch(() => {}), [])

  useEffect(() => {
    void load()
    window.addEventListener('focus', load)
    const timer = recording ? setInterval(load, RECORDING_REFRESH_MS) : undefined
    const off = window.yogurt.audio.onMics(({ fellBack }) => {
      if (fellBack) setLost(shown.current?.using ?? '')
      void load()
    })
    return () => { window.removeEventListener('focus', load); clearInterval(timer); off() }
  }, [recording, load])
  useEffect(() => {
    if (lost === null) return
    const timer = setTimeout(() => setLost(null), FELL_BACK_MS)
    return () => clearTimeout(timer)
  }, [lost])
  useEffect(() => { if (!recording) setLost(null) }, [recording])

  useEffect(() => {
    if (!open) return
    void load()
    const timer = setInterval(load, OPEN_REFRESH_MS)
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => { clearInterval(timer); document.removeEventListener('mousedown', away) }
  }, [open, load])
  // focus the checked row once the menu is there
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"]')?.focus()
  }, [open])

  const choose = async (id: string | null) => {
    setOpen(false); setLost(null); button.current?.focus()
    if (view) setView({ ...view, choice: id, using: id ? view.devices.find((d) => d.id === id)?.name ?? view.using : view.defaultName })
    await window.yogurt.audio.setMic(id).catch(() => false)
    void load()
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

  const name = view?.using ?? t('No microphone')
  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const tick = (on: boolean) => <Check size={15} aria-hidden="true" className={`ms-auto shrink-0 ${on ? '' : 'invisible'}`} />
  return (
    <div ref={root} className="relative flex min-w-0 items-center gap-1.5">
      <button ref={button} data-testid="rec-mic-chip" aria-haspopup="menu" aria-expanded={!!open} title={t('Microphone')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        className="bar-btn flex max-w-[220px] items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:text-ink aria-expanded:text-ink">
        <Swap show={paused ? 'paused' : 'mic'} options={{ mic: <Mic size={11} />, paused: <Pause size={11} fill="currentColor" strokeWidth={0} /> }} />
        <span data-testid="rec-mic" className="truncate">{paused ? t('Recording paused') : name}</span>
        <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
      </button>
      {lost !== null && (
        <span data-testid="rec-mic-note" role="status" className="text-ink">
          {lost ? t("{name} isn't available anymore. Recording continues with Auto.", { name: lost }) : t("Your mic isn't available anymore. Recording continues with Auto.")}
        </span>
      )}
      {open && view && (
        <div data-testid="mic-menu" data-pointer={open === 'pointer'} data-anchor="bottom-start" role="menu" aria-label={t('Microphone')} onKeyDown={onKey}
          className="menu-entry absolute bottom-full start-0 z-30 mb-2 w-72 rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          <button role="menuitemradio" aria-checked={view.choice === null} data-testid="mic-auto" onClick={() => void choose(null)} className={row}>
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5">
                {t('Auto')}
                <span data-testid="mic-auto-info" title={autoInfo()} aria-label={autoInfo()} className="text-muted">
                  <Info size={12} aria-hidden="true" />
                </span>
              </span>
              {view.defaultName && <span data-testid="mic-auto-name" className="truncate text-xs text-muted">{view.defaultName}</span>}
            </span>
            {tick(view.choice === null)}
          </button>
          {view.devices.length > 0 && <div aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--line)]" />}
          {view.devices.map((d) => (
            <button key={d.id} role="menuitemradio" aria-checked={view.choice === d.id} data-testid="mic-option" data-id={d.id} onClick={() => void choose(d.id)} className={row}>
              <span className="truncate">{d.name}</span>
              {tick(view.choice === d.id)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
