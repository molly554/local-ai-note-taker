import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis, X } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import type { MissingPermission } from '../../../shared/types'
import { finishSetupReason, finishSetupRemaining, permissionCopy } from '../permissionCopy'
import { TurnOn } from './TurnOn'
import { t } from '../../../shared/i18n'
import { finishSetupPercent, missing } from '../../../shared/onboarding'
import { supportedKinds } from '../../../shared/platform'
import { toasts } from './TrashToast'

/**
 * The sidebar's "Finish setup": what was put off in the first run, the ones recording needs first, each with its own
 * Turn on. Put away, it stays away until something else goes missing. Rechecked whenever Yogurt comes forward.
 */
/** the permissions this computer has (no calendar or names from calls on Windows and Linux) */
const kinds = () => supportedKinds(window.yogurt.capabilities)

export function FinishSetup({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false)
  const [percent, setPercent] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDialogElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<MissingPermission[]>([])
  // Replies from before Hide or Undo must not bring back the old checklist state.
  const readRevision = useRef(0)
  const hiding = useRef(false)
  const reload = useCallback(() => {
    if (hiding.current) return
    const revision = readRevision.current
    const read = Promise.all([window.yogurt.permissions.status(), panel.current?.open ? null : window.yogurt.onboarding.nudge()])
    void read.then(([status, nudge]) => {
      const next = nudge ?? missing(status, kinds())
      if (revision !== readRevision.current) return
      setPercent(finishSetupPercent(status, kinds())); setItems(next); if (!next.length) setOpen(false)
    }, () => {})
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    return () => { ++readRevision.current; window.removeEventListener('focus', reload) }
  }, [reload])
  const close = useCallback(() => { panel.current?.close(); setOpen(false); trigger.current?.focus({ preventScroll: true }) }, [])
  const hide = async () => {
    if (hiding.current) return
    hiding.current = true
    ++readRevision.current
    try {
      await window.yogurt.onboarding.dismissNudge()
      setOpen(false); setItems([])
      let restoring = false
      const id = toasts.add({ title: t('Setup checklist hidden'), timeout: 8000,
        data: { testId: 'setup-hidden', actionTestId: 'setup-undo' },
        actionProps: { children: t('Undo'), onClick: async () => {
          if (restoring) return
          restoring = true
          ++readRevision.current
          try { await window.yogurt.onboarding.restoreNudge(); ++readRevision.current; reload(); toasts.close(id) }
          catch { toasts.update(id, { title: t("Yogurt couldn't make that change. Try again."), timeout: 0 }) }
          finally { restoring = false }
        } },
      })
    } catch { toasts.add({ title: t("Yogurt couldn't make that change. Try again.") }) }
    finally { hiding.current = false }
  }
  useEffect(() => {
    const show = () => {
      if (hiding.current) return
      const revision = readRevision.current
      void window.yogurt.permissions.status().then((s) => {
        if (revision === readRevision.current) { setPercent(finishSetupPercent(s, kinds())); setItems(missing(s, kinds())); setOpen(true) }
      }, () => {})
    }
    window.addEventListener('yogurt:finish-setup', show)
    return () => window.removeEventListener('yogurt:finish-setup', show)
  }, [])
  useLayoutEffect(() => {
    const el = panel.current
    if (!open || !el) return
    el.show()
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      const rtl = getComputedStyle(el).direction === 'rtl'
      const start = rect ? rtl ? innerWidth - rect.right : rect.x : 12
      const bottom = Math.max(64, rect ? innerHeight - rect.y + 8 : 64)
      el.style.insetInlineStart = `${Math.max(12, Math.min(start, innerWidth - el.getBoundingClientRect().width - 12))}px`
      el.style.bottom = `${bottom}px`
      el.style.maxHeight = `${Math.max(120, innerHeight - bottom - 16)}px`
    }
    position()
    el.querySelector<HTMLButtonElement>('[data-testid="finish-setup-fix"]')?.focus()
    const away = (e: PointerEvent) => {
      if (document.querySelector('[aria-modal="true"], [role="alertdialog"]')) return
      if (!el.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"], [role="alertdialog"]')) { e.preventDefault(); close() }
    }
    window.addEventListener('resize', position); document.addEventListener('pointerdown', away); document.addEventListener('keydown', key)
    return () => { el.close(); window.removeEventListener('resize', position); document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [open, !!items.length, close, collapsed])
  if (!items.length) return null
  const remaining = finishSetupRemaining(items.length)
  return (
    <>
    <button ref={trigger} data-testid="finish-setup-open" data-sidebar="menu-button" aria-label={`${t('Finish setup')}, ${remaining}`} title={collapsed ? `${t('Finish setup')}, ${remaining}` : undefined} className="setup-checklist-trigger workspace-nav" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { reload(); setOpen((v) => !v) }}>
      <svg className="setup-progress" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2.5" className="setup-progress-track" /><circle cx="8" cy="8" r="5.5" pathLength="100" stroke="currentColor" strokeWidth="2.5" strokeDasharray="100" strokeDashoffset={100 - percent} strokeLinecap="round" /></svg>
      <span>{t('Finish setup')}</span><small data-testid="finish-setup-remaining">{remaining}</small>
    </button>
    {open && createPortal(<dialog ref={panel} data-testid="finish-setup" aria-label={t('Finish setup')} className="finish-setup"
      onCancel={(e) => { e.preventDefault(); close() }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      <div className="finish-setup-header">
        <h2>{t('Finish setup')}</h2>
        <div className="finish-setup-controls">
          <Menu.Root modal={false}>
            <Menu.Trigger data-testid="finish-setup-more" aria-label={t('More')} title={t('More')} className="finish-setup-close no-drag"><Ellipsis size={14} aria-hidden="true" /></Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6} className="ask-menu-positioner">
                <Menu.Popup ref={menu} className="menu-entry ask-actions-menu" aria-label={t('More')} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>
                  <Menu.Item data-testid="finish-setup-hide" onClick={() => void hide()}>{t('Hide checklist')}</Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <button data-testid="finish-setup-close" aria-label={t('Close')} title={t('Close')} className="finish-setup-close no-drag" onClick={close}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <ul>
        {items.map((m) => {
          const c = permissionCopy(m.kind)
          return (
            <li key={m.kind} data-testid="finish-setup-item" data-kind={m.kind} data-essential={m.essential} className="finish-setup-item">
              <div className="finish-setup-copy"><p title={c.name}>{m.kind === 'accessibility' ? t('Accessibility') : c.name}</p>
                <p id={`finish-setup-detail-${m.kind}`} data-testid="finish-setup-detail" className="finish-setup-detail">{finishSetupReason(m.kind)}</p>
              </div>
              <TurnOn kind={m.kind} status={m.status} onOn={reload} testId="finish-setup-fix" descriptionId={`finish-setup-detail-${m.kind}`} className="workspace-button finish-setup-action" />
            </li>
          )
        })}
      </ul>
    </dialog>, document.body)}
    </>
  )
}
