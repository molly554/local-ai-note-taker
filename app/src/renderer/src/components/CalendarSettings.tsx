import { useCallback, useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { t } from '../../../shared/i18n'

let expanded = false

export function CalendarSettings() {
  const [view, setView] = useState<Awaited<ReturnType<typeof window.yogurt.calendar.list>>>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(expanded)
  const reload = useCallback(() => {
    void window.yogurt.calendar.list().then(setView, () => setView({ status: 'error', calendars: [] }))
  }, [])
  useEffect(() => { reload(); window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload) }, [reload])
  const choose = async (id: string, enabled: boolean) => {
    setBusy(true); setError(false)
    setView((v) => v && { ...v, calendars: v.calendars.map((c) => c.id === id ? { ...c, enabled } : c) })
    try {
      if (!await window.yogurt.calendar.setEnabled(id, enabled)) throw new Error('Calendar unavailable')
    } catch { setError(true); reload() } finally { setBusy(false) }
  }
  const selected = view?.calendars.filter(c => c.enabled) ?? []
  // Yogurt holds no calendar accounts: disconnecting unticks every calendar; the Mac's own access stays in System Settings
  const disconnect = async () => {
    const ids = selected.map(c => c.id)
    setBusy(true); setError(false)
    setView((v) => v && { ...v, calendars: v.calendars.map((c) => ({ ...c, enabled: false })) })
    try {
      for (const id of ids) if (!await window.yogurt.calendar.setEnabled(id, false)) throw new Error('Calendar unavailable')
    } catch { setError(true); reload() } finally { setBusy(false) }
  }
  const summary = !view ? t('Loading calendars…')
    : view.status === 'error' ? t("Yogurt couldn't read your calendars.")
    : view.status !== 'granted' ? t('Allow calendar access to choose your calendars.')
    : !view.calendars.length ? t('No calendars found on this Mac.')
    : !selected.length ? t('No calendars selected.')
    : selected.length === 1 ? [selected[0].name, selected[0].source].filter(Boolean).join(' · ')
    : `${selected[0].name} ${t('and {count} more', { count: selected.length - 1 })}`
  return <section data-testid="calendar-settings">
    <h2 className="settings-section-heading">{t('Calendars')}</h2>
    <div className="settings-group">
      <button type="button" data-testid="calendar-settings-toggle" aria-expanded={open} aria-controls="settings-calendar-list" onClick={() => { expanded = !open; setOpen(expanded) }} className="settings-row settings-disclosure">
        <span className="settings-row-copy">
          <LoadingContent pending={!view} skeleton={<span className="settings-label settings-calendar-summary"><span className="loading-bar" style={{ width: 150 }} /></span>}><span data-testid="calendar-settings-summary" className="settings-label settings-calendar-summary" title={summary}>{summary}</span></LoadingContent>
          <span className="settings-description block">{t('Choose which calendars Yogurt uses for your agenda and meeting reminders. Your calendar events stay unchanged.')}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id="settings-calendar-list" className="accordion" data-open={open} inert={!open || undefined}><div className="settings-calendar-list">
        <LoadingContent pending={!view} skeleton={<Loading layout="calendars" />}>{view && (view.status !== 'granted' ? <div className="settings-row">
            <p className="settings-description settings-row-copy">{view.status === 'error' ? t("Yogurt couldn't read your calendars.") : t('Allow calendar access to choose your calendars.')}</p>
            <button className="workspace-button" onClick={() => { if (view.status === 'error') reload(); else void window.yogurt.calendar.connect().then(reload) }}>{view.status === 'error' ? t('Try again') : t('Connect calendar')}</button>
          </div>
          : !view.calendars.length ? <p className="settings-row settings-description">{t('No calendars found on this Mac.')}</p>
          : view.calendars.map((c) => <label key={c.id} data-testid="calendar-choice" className="settings-row settings-calendar-choice">
            <span className="settings-calendar-dot" style={{ backgroundColor: c.color }} aria-hidden="true" />
            <span className="settings-row-copy"><span className="settings-label">{c.name}</span><span className="settings-description block">{c.source}</span></span>
            <input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => void choose(c.id, e.target.checked)} />
          </label>))}</LoadingContent>
        {view?.status === 'granted' && view.calendars.length > 0 && <div data-testid="calendar-disconnect" className="settings-calendar-actions">
          <div className="settings-row">
            <span className="settings-row-copy"><span className="settings-label">{t('Disconnect calendars')}</span><span className="settings-description block">{t('Yogurt stops using these calendars.')}</span></span>
            <button type="button" data-testid="calendar-disconnect-all" className="workspace-button shrink-0" disabled={busy || !selected.length} onClick={() => void disconnect()}>{t('Disconnect')}</button>
          </div>
          <div className="settings-row">
            <span className="settings-row-copy"><span className="settings-label">{t('Calendar access')}</span><span className="settings-description block">{t('Remove Yogurt’s access in System Settings.')}</span></span>
            <button type="button" className="workspace-button shrink-0" onClick={() => void window.yogurt.permissions.open('calendar')}>{t('Open System Settings')}</button>
          </div>
        </div>}
        {error && <p role="alert" className="settings-row text-danger">{t("Couldn't update your calendars. Try again.")}</p>}
      </div></div>
    </div>
  </section>
}
