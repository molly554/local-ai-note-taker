import { useEffect, useState } from 'react'
import { Check, MicOff, RotateCw, TriangleAlert } from 'lucide-react'
import type { PermissionKind, PermissionStatus, WidgetView } from '../../../shared/types'
import { TurnOn } from './TurnOn'
import { t } from '../../../shared/i18n'

const KIND: Record<'no-mic' | 'no-system-audio', PermissionKind> = { 'no-mic': 'mic', 'no-system-audio': 'systemAudio' }

/**
 * What the recorder has to say under the note. A missing mic or call audio says so plainly, with a button that turns it
 * on (the Mac's prompt or System Settings). The recording already going keeps what it has; the next one gets it all.
 */
export function RecordingHint({ hint }: { hint: NonNullable<WidgetView['note']> }) {
  const kinds = hint.missingAudio ?? (hint.code ? [KIND[hint.code]] : [])
  const [permissions, setPermissions] = useState<PermissionStatus>()
  const [fixed, setFixed] = useState(false)
  const reload = () => { void window.yogurt.permissions.status().then(setPermissions, () => {}) }
  useEffect(() => {
    setFixed(false); setPermissions(undefined)
    if (!kinds.length) return
    reload(); window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [hint.code, kinds.join(',')])
  const kind = kinds.find((k) => permissions?.[k] !== 'granted') ?? kinds[0]
  const access = kind ? permissions?.[kind] : undefined
  // only after the person turned it on here: a warning with access already on is something else (say, no mic plugged in)
  const on = fixed && kinds.every((k) => permissions?.[k] === 'granted')
  const Icon = hint.tone === 'hiccup' ? RotateCw : on ? Check : hint.code === 'no-mic' ? MicOff : TriangleAlert
  return (
    <div data-testid="rec-hint" data-tone={hint.tone} data-code={hint.code} className="pointer-events-auto mx-auto mt-3 flex w-fit max-w-[640px] items-center gap-2.5 rounded-xl border border-line bg-float px-4 py-2 text-[13px] leading-snug shadow-[var(--shadow)]" role="status">
      <Icon size={14} strokeWidth={1.75} className={`shrink-0 ${on ? 'text-accent' : 'text-danger'}`} aria-hidden="true" />
      <span>{on ? (kinds.length > 1 ? t('Permissions are on. Finish this recording, then start again to use them.') : kind === 'mic' ? t('Microphone is on. Your next recording uses it.') : t('Call audio is on. Your next recording uses it.')) : hint.text}</span>
      {/* Windows: no prompt to ask with, so its own microphone page (Linux never reads as off) */}
      {!window.yogurt.capabilities.permissionPrompts && kind && access === 'denied' && (
        <button data-testid="rec-hint-fix" data-kind={kind} onClick={() => void window.yogurt.permissions.open(kind)} className="workspace-button primary shrink-0 no-drag">{t('Open Settings')}</button>
      )}
      {window.yogurt.capabilities.permissionPrompts && kind && !on && access && access !== 'restricted' && access !== 'granted' && (
        <TurnOn key={kind} kind={kind} status={access} recording onOn={() => { setFixed(true); reload() }} label={kinds.length > 1 ? kind === 'mic' ? t('Turn on microphone') : t('Turn on call audio') : undefined} testId="rec-hint-fix" className="workspace-button primary shrink-0" />
      )}
    </div>
  )
}
