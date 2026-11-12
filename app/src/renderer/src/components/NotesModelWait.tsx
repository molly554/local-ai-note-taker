import { useEffect, useState, type ReactNode } from 'react'
import type { SetupState } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { notesPercent } from '../notesSetup'

/**
 * Waiting notes and answers share the first model's failure and its existing setup retry. downloading: what to show
 * instead while the first notes model is still downloading (every system reports how far it is, as percent).
 */
export function NotesModelWait({ children, downloading }: { children: ReactNode; downloading?: (percent: string) => ReactNode }) {
  const [setup, setSetup] = useState<SetupState>()
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  useEffect(() => {
    const off = window.yogurt.setup.onState((s) => { setSetup(s); if (!s.notesError) setRetryFailed(false) })
    void window.yogurt.setup.state().then((s) => setSetup((current) => current ?? s))
    return off
  }, [])
  const retry = async () => {
    setRetrying(true); setRetryFailed(false)
    try { await window.yogurt.setup.retry() } catch { setRetryFailed(true) }
    finally { setRetrying(false) }
  }
  if (!setup?.notesError) {
    if (downloading && setup && (setup.notesFraction !== undefined || setup.notesDownloading)) return downloading(notesPercent(setup.notesFraction ?? 0))
    return children
  }
  return (
    <div data-testid="notes-model-error" role="status" className="flex flex-col items-start gap-2 text-[14px] text-muted">
      <p className="font-medium text-ink">{t("The notes model couldn't download.")}</p>
      <p>{setup.notesError}</p>
      <button data-testid="notes-model-retry" onClick={() => void retry()} disabled={retrying} className="rounded px-1 font-medium text-accent underline underline-offset-2 disabled:opacity-50">
        {retrying ? t('Retrying…') : t('Retry download')}
      </button>
      {retryFailed && <p className="text-danger">{t("Couldn't restart the download. Try again.")}</p>}
    </div>
  )
}
