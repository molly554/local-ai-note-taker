import { useEffect, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { ChevronDown } from 'lucide-react'
import type { SetupState } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { notesDownloadText, notesPercent } from '../notesSetup'

/** The first model's download lives beside the note's mic, language and save status. */
export function NotesSetup() {
  const [setup, setSetup] = useState<SetupState>()
  const [open, setOpen] = useState(false)
  const [pointer, setPointer] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  useEffect(() => {
    let current: SetupState | undefined, active = true
    const update = (state: SetupState) => {
      current = state; setSetup(state)
      if (!state.notesError) setRetryFailed(false)
      if (!state.notesDownloading && !state.notesError) setOpen(false)
    }
    const off = window.yogurt.setup.onState(update)
    void window.yogurt.setup.state().then(state => { if (active && !current) update(state) })
    return () => { active = false; off() }
  }, [])
  const retry = async () => {
    setRetrying(true); setRetryFailed(false)
    try { await window.yogurt.setup.retry() } catch { setRetryFailed(true) }
    finally { setRetrying(false) }
  }
  if (!setup || (!setup.notesDownloading && !setup.notesError)) return null
  const failed = !!setup.notesError
  const label = failed ? t("AI download stopped") : t('Downloading AI · {percent}', { percent: notesPercent(setup.notesFraction ?? 0) })
  const text = notesDownloadText(setup)
  return <span className="notes-download-status flex min-w-0 items-center gap-1.5">
    <span aria-hidden="true">·</span>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="notes-setup-open" title={failed ? setup.notesError : text.title} onClick={e => setPointer(e.detail > 0)}
        className="bar-btn flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:text-ink aria-expanded:text-ink">
        <span aria-hidden="true" data-failed={failed} className="notes-download-dot" />
        <span className="truncate">{label}</span><ChevronDown size={11} aria-hidden="true" className="shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} positionMethod="fixed" className="notes-download-positioner">
          <Popover.Popup data-testid="notes-setup" data-failed={failed} data-pointer={pointer} data-anchor="bottom-start" aria-label={failed ? t('AI download stopped') : t('Downloading AI')} className="menu-entry notes-download-menu">
            {failed ? <>
              <p role="status">{retryFailed ? t("Couldn't restart the download. Try again.") : setup.notesError}</p>
              <button data-testid="notes-setup-retry" className="inline-error-action notes-download-retry" disabled={retrying} onClick={() => void retry()}>{retrying ? t('Retrying…') : t('Try again')}</button>
            </> : <>
              <p>{text.detail}</p>
              <p className="text-muted">{t('You can record now. Yogurt writes your notes and answers questions once this finishes.')}</p>
            </>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </span>
}
