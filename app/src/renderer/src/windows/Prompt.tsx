import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { PromptView } from '../../../shared/types'
import { Logo } from '../components/Logo'
import { t } from '../../../shared/i18n'
import macIcon from '../../../../build/icon.png'

/** The small card that offers to take notes when a call starts, and asks whether to stop when it ends. */
export function Prompt() {
  const [view, setView] = useState<PromptView | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [countdown, setCountdown] = useState(0)
  useEffect(() => { void window.yogurt.prompt.state().then(setView) }, [])
  useEffect(() => {
    if (view?.kind !== 'start' || hovered || focused) return
    // The bar and dismissal both restart after the person finishes interacting.
    setCountdown(cycle => cycle + 1)
    const timer = setTimeout(() => window.yogurt.prompt.act('close'), 12_000)
    return () => clearTimeout(timer)
  }, [view, hovered, focused])
  if (!view) return <div className="h-full bg-bg" />

  const start = view.kind === 'start'
  const name = start && view.app ? t('{app} call', { app: view.app }) : view.title || t('Meeting')
  return (
    <div data-testid="prompt" data-kind={view.kind} data-paused={hovered || focused} className="call-prompt"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false) }}>
      {start && <span key={countdown} data-testid="prompt-countdown" className="call-prompt-countdown" aria-hidden="true" />}
      <div className="call-prompt-heading">
        {start ? <img src={macIcon} alt="" className="call-prompt-icon" /> : <Logo size={28} className="call-prompt-logo" />}
        <div className="min-w-0 flex-1">
          <p data-testid="prompt-heading" className="call-prompt-label">{start ? t('Take notes?') : t('Stop recording?')}</p>
          <p data-testid="prompt-title" className="call-prompt-title" title={view.title || name}>{name}</p>
        </div>
      </div>
      <div className="call-prompt-actions">
        {start ? (
          <button data-testid="prompt-take-notes" className="workspace-button" onClick={() => window.yogurt.prompt.act('take-notes')}>
            {t('Start recording')}
          </button>
        ) : (
          <>
            <button data-testid="prompt-keep-going" className="workspace-button" onClick={() => window.yogurt.prompt.act('keep-going')}>
              {t('Keep going')}
            </button>
            <button data-testid="prompt-stop" className="workspace-button primary" onClick={() => window.yogurt.prompt.act('stop')}>
              {t('Stop')}
            </button>
          </>
        )}
      </div>
      {start && (
        <button data-testid="prompt-close" aria-label={t('Not now')} className="call-prompt-close" onClick={() => window.yogurt.prompt.act('close')}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
