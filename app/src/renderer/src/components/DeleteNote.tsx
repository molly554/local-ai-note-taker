import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { Modal, ModalClose } from './Modal'
import { InlineError } from './InlineError'

/**
 * Delete forever, from the Trash: a permanent deletion, with Cancel focused first. Yes deletes audio too; main
 * refuses while it records. onDone: after it is gone, or after Cancel.
 */
export function DeleteNote({ id, title, onDone }: { id: string; title: string; onDone: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<'recording' | 'save-pending' | 'failed' | null>(null)
  const cancel = () => onDone(false)
  const yes = async () => {
    setBusy(true); setFailed(null)
    const r = await window.yogurt.meetings.delete(id).catch(() => 'failed' as const)
    setBusy(false)
    if (r === 'deleted' || r === 'missing') onDone(true)
    else setFailed(r)
  }
  return (
    <Modal testId="delete-confirm" role="alertdialog" title={t('Delete “{title}” forever?', { title })}
      description={osWords({ mac: t('Its notes, transcript and recording are removed from this Mac for good.'), other: t('Its notes, transcript and recording are removed from this computer for good.') })}
      onCancel={cancel} busy={busy}>
        {failed && <InlineError testId="delete-failed" className="inline-error-in-dialog"><span>{failed === 'recording' ? t('Stop the recording first, then try again.')
          : failed === 'save-pending' ? t('Open this note and finish saving before deleting it.')
          : t("Yogurt couldn't finish deleting this note. Try again.")}</span></InlineError>}
        <div className="modal-actions">
          <button data-testid="delete-yes" onClick={() => void yes()} disabled={busy} className="modal-button danger">{t('Delete forever')}</button>
          <ModalClose data-testid="delete-cancel" data-dialog-cancel disabled={busy} className="modal-button">{t('Cancel')}</ModalClose>
        </div>
    </Modal>
  )
}
