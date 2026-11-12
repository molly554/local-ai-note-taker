import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { PermissionKind } from '../../../shared/types'
import { permissionCopy } from '../permissionCopy'
import { SettingsWindowArt } from './OnboardingArt'
import { t } from '../../../shared/i18n'

/**
 * While the person is in System Settings: where to click, with a picture of it, and that Yogurt notices by itself.
 * Some permissions only apply once Yogurt opens again, so one button does that (never while recording).
 */
export function SettingsGuide({ kind, onOpenAgain, canRelaunch, art = true }: { kind: PermissionKind; onOpenAgain(): void; canRelaunch: boolean; /** false: the picture is shown elsewhere (the first run's illustration slot) */ art?: boolean }) {
  const [relaunchFailed, setRelaunchFailed] = useState(false)
  const c = permissionCopy(kind)
  return (
    <div data-testid="settings-guide" className="ob-guide">
      {art && <SettingsArt kind={kind} />}
      <p className="ob-guide-copy">{c.where}</p>
      <p data-testid="settings-guide-waiting" role="status" className="ob-guide-waiting">{t('This closes automatically when access is on.')}</p>
      <div className="ob-guide-actions">
        <button data-testid="settings-guide-open" onClick={onOpenAgain} className="settings-link no-drag">
          <span>{t('Open System Settings')}</span><ExternalLink size={13} aria-hidden="true" className="rtl:-scale-x-100" />
        </button>
      </div>
      {(canRelaunch || kind === 'accessibility' || kind === 'systemAudio') && <details key={kind} className="ob-guide-help">
        <summary>{t('Still not working?')}</summary>
        <div className="ob-guide-help-content">
        {(kind === 'accessibility' || kind === 'systemAudio') && <p>{t('Not in the list? Click +, then choose Yogurt in Applications.')}</p>}
        {canRelaunch && <><p>{t('If you turned access on and this stays open, restart Yogurt.')}</p><button data-testid="settings-guide-relaunch" className="ob-button secondary no-drag" onClick={() => {
          void window.yogurt.permissions.relaunch().then((ok) => setRelaunchFailed(!ok), () => setRelaunchFailed(true))
        }}><span>{t('Restart Yogurt')}</span></button></>}
      </div>
      </details>}
      {relaunchFailed && <p role="alert" className="ob-guide-note">{t("Yogurt couldn't reopen. Quit it from the menu bar and open it again.")}</p>}
    </div>
  )
}

/** The pane as System Settings shows it, with Yogurt's switch */
export function SettingsArt({ kind }: { kind: PermissionKind }) {
  return <SettingsWindowArt pane={permissionCopy(kind).pane} section={kind === 'systemAudio' ? t('System Audio Recording Only') : undefined} />
}
