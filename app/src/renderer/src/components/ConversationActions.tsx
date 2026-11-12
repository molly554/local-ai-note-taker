import { useCallback, useRef, useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { Modal, ModalClose } from './Modal'

type Edit = 'rename' | 'delete'
/** The same actions in Recent, the full thread and the note panel. */
export function ConversationActions({ id, title, onNew, onDeleted, onEdit, className = '' }: {
  id: string; title: string; onNew?: () => void; onDeleted: () => void; onEdit?: (kind: Edit) => void; className?: string
}) {
  const button = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLElement | null>(null)
  const mountButton = useCallback((node: HTMLButtonElement | null) => { button.current = node; container.current = node?.closest('dialog') ?? null }, [])
  const [dialog, setDialog] = useState<Edit>()
  const edit = (kind: Edit) => { button.current?.focus(); if (onEdit) onEdit(kind); else setDialog(kind) }
  const cancel = () => { setDialog(undefined); button.current?.focus({ preventScroll: true }) }
  return <>
    <Menu.Root modal={false}>
      <Menu.Trigger ref={mountButton} data-testid="chat-menu" className={`chat-icon ask-menu-trigger ${className}`} aria-label={t('More')} title={t('More')}><Ellipsis size={17} aria-hidden="true" /></Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="ask-menu-positioner">
          <Menu.Popup className="menu-entry ask-actions-menu" aria-label={t('More')} finalFocus={dialog ? false : button} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>
            <Menu.Item data-testid="chat-rename" onClick={() => edit('rename')}><Pencil size={14} aria-hidden="true" />{t('Rename')}</Menu.Item>
            {onNew && <Menu.Item data-testid="chat-new" onClick={onNew}><Plus size={14} aria-hidden="true" />{t('New chat')}</Menu.Item>}
            <Menu.Item data-testid="chat-delete" className="text-danger" onClick={() => edit('delete')}><Trash2 size={14} aria-hidden="true" />{t('Delete')}</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
    {dialog && <ConversationDialog id={id} title={title} kind={dialog} container={container.current ?? undefined} onClose={cancel} onDeleted={onDeleted} />}
  </>
}

/** Recent owns this outside its dismissible popup, so opening a dialog cannot unmount the edit. */
export function ConversationDialog({ id, title, kind, container, onClose, onDeleted }: {
  id: string; title: string; kind: Edit; container?: HTMLElement | null; onClose: () => void; onDeleted: () => void
}) {
  const [draft, setDraft] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const save = async () => {
    if (busy || kind === 'rename' && !draft.trim()) return
    setBusy(true); setError(false)
    try {
      if (kind === 'delete') await window.yogurt.conversations.delete(id)
      else await window.yogurt.conversations.rename(id, draft.trim())
      onClose()
      if (kind === 'delete') onDeleted()
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  return <Modal fade container={container} busy={busy} testId={kind === 'delete' ? 'chat-delete-confirm' : 'chat-rename-dialog'}
    role={kind === 'delete' ? 'alertdialog' : 'dialog'} onCancel={onClose}
    title={kind === 'delete' ? t('Delete “{title}”?', { title: title || t('New chat') }) : t('Rename “{title}”', { title: title || t('New chat') })}
    description={kind === 'delete' ? osWords({ mac: t('This conversation is removed from this Mac for good. Your meetings stay as they are.'), other: t('This conversation is removed from this computer for good. Your meetings stay as they are.') }) : undefined}>
    <form onSubmit={e => { e.preventDefault(); void save() }}>
      {kind === 'rename' && <input data-dialog-focus data-testid="chat-rename-input" aria-label={t('Conversation name')} value={draft} maxLength={200}
        className="chat-rename-input" disabled={busy} onChange={e => setDraft(e.target.value)} />}
      {error && <p className="chat-error" role="alert">{t("Couldn't save your changes")}</p>}
      <div className="modal-actions">
        <button type="submit" data-testid={kind === 'delete' ? 'chat-delete-yes' : 'chat-rename-save'} disabled={busy || kind === 'rename' && !draft.trim()}
          className={`modal-button${kind === 'delete' ? ' danger' : ''}`}>{kind === 'delete' ? t('Delete') : t('Save')}</button>
        <ModalClose type="button" data-dialog-cancel data-testid="chat-delete-cancel" className="modal-button" disabled={busy}>{t('Cancel')}</ModalClose>
      </div>
    </form>
  </Modal>
}
