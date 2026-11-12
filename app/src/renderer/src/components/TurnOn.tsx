import { useEffect } from 'react'
import type { Access, PermissionKind } from '../../../shared/types'
import { permissionCopy } from '../permissionCopy'
import { usePermissionFlow } from '../permissionFlow'
import { Modal, ModalClose } from './Modal'
import { SettingsGuide } from './SettingsGuide'
import { t } from '../../../shared/i18n'

/**
 * A button that turns one permission on, after the first run: the Mac's prompt where there is one, else System
 * Settings with the guide in a dialog, which closes by itself once it is on.
 */
export function TurnOn({ kind, status, onOn, recording = false, className = 'workspace-button primary', testId = 'turn-on', label, descriptionId }: {
  kind: PermissionKind; status: Access; onOn(): void; recording?: boolean; className?: string; testId?: string; label?: string; descriptionId?: string
}) {
  const flow = usePermissionFlow(kind, status, onOn)
  useEffect(() => { if (flow.phase === 'back') { flow.stop(); onOn() } }, [flow.phase])
  const c = permissionCopy(kind)
  return (
    <>
      <button aria-describedby={descriptionId} data-testid={testId} data-kind={kind} disabled={flow.phase === 'asking'} onClick={() => void flow.allow()} className={`${className} no-drag`}>
        {label ?? t('Turn on')}
      </button>
      {flow.phase === 'away' && (
        <Modal testId="permission-guide" title={t('Turn it on in System Settings')} description={t('System Settings is open at {pane}.', { pane: c.pane })} onCancel={flow.stop}>
          <div className="modal-guide"><SettingsGuide kind={kind} canRelaunch={!recording} onOpenAgain={() => void flow.openSettings()} /></div>
          <div className="modal-actions">
            <ModalClose data-testid="permission-guide-close" data-dialog-cancel className="modal-button">{t('Close')}</ModalClose>
          </div>
        </Modal>
      )}
    </>
  )
}
