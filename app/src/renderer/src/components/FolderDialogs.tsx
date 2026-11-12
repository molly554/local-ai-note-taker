import { useState } from 'react'
import { DEFAULT_FOLDER_APPEARANCE, type FolderAppearance } from '../../../shared/folderAppearance'
import { FolderChoices, FolderGlyph } from './FolderAppearance'
import type { Folder } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { Modal, ModalClose } from './Modal'

/**
 * Naming a folder: a new one (then onDone gets it, so a note can go straight in), or renaming one. Return saves,
 * Escape or Cancel keeps things as they were.
 */
export function FolderName({ folder, onDone }: { folder?: Folder; onDone: (made?: Folder) => void }) {
  const [appearance, setAppearance] = useState<FolderAppearance>(folder ?? DEFAULT_FOLDER_APPEARANCE)
  const [name, setName] = useState(folder?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setFailed(false)
    try {
      if (folder) { await window.yogurt.folders.rename(folder.id, name); onDone() }
      else {
        const made = await window.yogurt.folders.create(name, appearance)
        if (!made) throw new Error('Folder not created')
        onDone(made)
      }
    } catch { setFailed(true); setBusy(false) }
  }
  return (
    <Modal testId="folder-name" title={folder ? t('Rename folder') : t('New folder')}
      description={folder ? t('Its meetings stay in it.') : t('A folder keeps related meetings together. A meeting can be in more than one.')}
      onCancel={() => onDone()} busy={busy}>
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="people-add-field mx-5 mb-4 flex h-9 items-center gap-2 rounded-md border border-line bg-card px-2.5">
          <FolderGlyph appearance={appearance} size={15} />
          <input data-dialog-focus data-testid="folder-name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
            placeholder={t('Folder name')} aria-label={t('Folder name')}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" />
        </div>
        {!folder && <FolderChoices value={appearance} onChange={setAppearance} disabled={busy} />}
        {failed && <p className="modal-error" role="alert">{t("Yogurt couldn't save this folder. Try again.")}</p>}
        <div className="modal-actions">
          <button data-testid="folder-name-save" type="submit" disabled={busy || !name.trim()} className="modal-button primary">{folder ? t('Rename') : t('Create folder')}</button>
          <ModalClose data-testid="folder-name-cancel" type="button" data-dialog-cancel disabled={busy} className="modal-button">{t('Cancel')}</ModalClose>
        </div>
      </form>
    </Modal>
  )
}

/** Deleting a folder, Cancel first: only the folder goes, its meetings stay in Meetings */
export function DeleteFolder({ folder, onDone }: { folder: Folder; onDone: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const yes = async () => {
    setBusy(true); setFailed(false)
    try { await window.yogurt.folders.delete(folder.id); onDone(true) } catch { setFailed(true); setBusy(false) }
  }
  return (
    <Modal testId="folder-delete-confirm" role="alertdialog" title={t('Delete “{name}”?', { name: folder.name })}
      description={t('Only the folder is deleted. Its meetings stay in Meetings.')} onCancel={() => onDone(false)} busy={busy}>
      {failed && <p className="modal-error" role="alert">{t("Yogurt couldn't delete this folder. Try again.")}</p>}
      <div className="modal-actions">
        <button data-testid="folder-delete-yes" onClick={() => void yes()} disabled={busy} className="modal-button danger">{t('Delete folder')}</button>
        <ModalClose data-testid="folder-delete-cancel" data-dialog-cancel disabled={busy} className="modal-button">{t('Cancel')}</ModalClose>
      </div>
    </Modal>
  )
}

export function FolderAppearanceDialog({ folder, onDone }: { folder: Folder; onDone: () => void }) {
  const [appearance, setAppearance] = useState<FolderAppearance>({ icon: folder.icon, color: folder.color })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true); setFailed(false)
    try {
      if (!await window.yogurt.folders.appearance(folder.id, appearance)) throw new Error('Folder not saved')
      onDone()
    } catch { setFailed(true); setBusy(false) }
  }
  return <Modal testId="folder-appearance" title={t('Change icon')} onCancel={onDone} busy={busy}>
    <div className="folder-appearance-preview"><span className="folder-preview-tile" data-folder-color={appearance.color}><FolderGlyph appearance={appearance} size={23} /></span><strong>{folder.name}</strong></div>
    <FolderChoices value={appearance} onChange={setAppearance} disabled={busy} />
    {failed && <p className="modal-error" role="alert">{t("Yogurt couldn't save this folder. Try again.")}</p>}
    <div className="modal-actions">
      <button data-testid="folder-appearance-save" onClick={() => void save()} disabled={busy} className="modal-button primary">{t('Save')}</button>
      <ModalClose data-dialog-cancel disabled={busy} className="modal-button">{t('Cancel')}</ModalClose>
    </div>
  </Modal>
}
