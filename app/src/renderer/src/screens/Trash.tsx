import { LoadingContent } from '../components/LoadingContent'
import { MeetingListLoading } from './Home'
import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import type { MeetingCard } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { TRASH_DAYS } from '../../../shared/trash'
import { useScrollMemory } from '../useScrollMemory'
import { dayLabel } from '../dates'
import { DeleteNote } from '../components/DeleteNote'
import { Modal, ModalClose } from '../components/Modal'
import { PastCard } from './Home'
import { useMyName } from '../components/People'

/**
 * The Trash: deleted meetings, the last deleted first. Each can be restored (back in its folders) or deleted for good;
 * Empty Trash deletes them all. Main deletes one by itself once it has been here TRASH_DAYS days.
 */
export function Trash({ open }: { open: (id: string) => void }) {
  const me = useMyName()
  const [cards, setCards] = useState<MeetingCard[]>()
  const scroll = useScrollMemory<HTMLDivElement>('trash', !!cards)
  const [deleting, setDeleting] = useState<MeetingCard>()
  const [emptying, setEmptying] = useState(false)
  const reload = useCallback(() => { void window.yogurt.meetings.trashed().then(setCards) }, [])
  useEffect(() => {
    reload()
    return window.yogurt.meetings.onChange(reload)
  }, [reload])
  return <div data-testid="trash-page" className="native-folder">
    <div className="home-toolbar-action no-drag">
      {!!cards?.length && <button data-testid="trash-empty" className="workspace-button" onClick={() => setEmptying(true)}>{t('Empty Trash')}</button>}
    </div>
    <div className="native-library" ref={scroll}>
      <h1>{t('Trash')}</h1>
      <p className="trash-note">{t('Meetings in the Trash are deleted for good after {count} days, with their recordings.', { count: TRASH_DAYS })}</p>
      <LoadingContent pending={!cards} testId="meetings-loading" skeleton={<MeetingListLoading grouped={false} />} className="library-load">{!cards?.length ? <section data-testid="trash-none" className="library-empty empty-state"><div className="empty-state-content">
        <div className="empty-tile"><Trash2 size={28} strokeWidth={1.5} aria-hidden="true" /></div><h2>{t('The Trash is empty')}</h2>
        <p>{t('Deleted meetings stay here for a while, so you can bring them back.')}</p>
      </div></section> : <ul aria-label={t('Deleted meetings')}>
        {cards?.map((c) => <li key={c.id} data-testid="trash-row" className="native-meeting-row trash-row row-swap" tabIndex={0} title={dayLabel(c.startedAt)}>
          <PastCard c={c} onOpen={open} me={me} fixed />
          <div className="trash-actions row-swap-actions"><button data-testid="trash-restore" title={t('Restore')} className="workspace-icon" onClick={() => void window.yogurt.meetings.restore(c.id)} aria-label={t('Restore')}>
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button data-testid="trash-delete" className="workspace-icon meeting-delete" onClick={() => setDeleting(c)} aria-label={t('Delete now')} title={t('Delete now')}>
            <Trash2 size={14} aria-hidden="true" />
          </button></div>
        </li>)}
      </ul>}</LoadingContent>
    </div>
    {deleting && <DeleteNote id={deleting.id} title={deleting.title} onDone={() => setDeleting(undefined)} />}
    {emptying && cards && <EmptyTrash count={cards.length} onDone={() => setEmptying(false)} />}
  </div>
}

/** Empty Trash asks first, Cancel focused; a meeting that couldn't go stays in the Trash and says so */
function EmptyTrash({ count, onDone }: { count: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const yes = async () => {
    setBusy(true); setFailed(false)
    const r = await window.yogurt.meetings.emptyTrash().catch(() => ({ deleted: 0, failed: 1 }))
    setBusy(false)
    if (r.failed) setFailed(true)
    else onDone()
  }
  return <Modal testId="trash-empty-confirm" role="alertdialog" title={t('Empty the Trash?')}
    description={osWords({ mac: t('{count} meetings, with their notes, transcripts and recordings, are removed from this Mac for good.', { count }), other: t('{count} meetings, with their notes, transcripts and recordings, are removed from this computer for good.', { count }) })} onCancel={onDone} busy={busy}>
    {failed && <p className="modal-error" role="alert">{t("Yogurt couldn't delete everything in the Trash. Try again.")}</p>}
    <div className="modal-actions">
      <button data-testid="trash-empty-yes" onClick={() => void yes()} disabled={busy} className="modal-button danger">{t('Empty Trash')}</button>
      <ModalClose data-testid="trash-empty-cancel" data-dialog-cancel disabled={busy} className="modal-button">{t('Cancel')}</ModalClose>
    </div>
  </Modal>
}
