import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mic } from './Icons'
import { toasts } from './TrashToast'
import { t } from '../../../shared/i18n'

/** A fresh recording from a library destination; main owns capture and opening the note. */
export function StartRecording({ onStarted }: { onStarted?: (id: string) => void }) {
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const [recording, setRecording] = useState<boolean>()
  const [starting, setStarting] = useState(false)
  useLayoutEffect(() => {
    setActions(document.getElementById('workspace-actions'))
    let active = true, updated = false
    const off = window.yogurt.widget.onState((view) => { updated = true; setRecording(view?.kind === 'recording') })
    void window.yogurt.widget.state().then((view) => { if (active && !updated) setRecording(view?.kind === 'recording') })
    return () => { active = false; off() }
  }, [])
  const start = async () => {
    if (starting || recording !== false) return
    setStarting(true); toasts.close('start-recording-message')
    try {
      const result = await window.yogurt.meetings.start(null)
      if ('error' in result) throw new Error(result.error)
      if (!result.alreadyRecording) onStarted?.(result.id)
    } catch {
      toasts.add({ id: 'start-recording-message', data: { testId: 'start-recording-message' }, title: t("Yogurt couldn't start the notes. Try again in a moment.") })
    } finally { setStarting(false) }
  }
  if (recording === true || !actions) return null
  return createPortal(<button data-testid="start-recording" disabled={starting || recording === undefined} onClick={() => void start()} className="workspace-button primary no-drag">
      <Mic size={14} aria-hidden="true" />{t('Start recording')}
    </button>, actions)
}
