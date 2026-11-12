import { useEffect, useState } from 'react'
import { ChevronDown, LayoutTemplate, ListChecks, PenLine } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { EXTRA_CHARS, TEMPLATES, type NotesStyle, type NotesStylePatch, type Template } from '../../../shared/templates'
import { LoadingContent } from './LoadingContent'

/** A template's name. Each is written out, so the translation tables find it (scripts/i18n-keys.mjs) */
export function templateName(v: Template): string {
  switch (v) {
    case 'team': return t('Team meeting')
    case 'one-on-one': return t('One-on-one')
    case 'customer': return t('Customer call')
    case 'interview': return t('Interview')
    default: return t('Any meeting')
  }
}

/**
 * Settings → Summary: how every Summary is written. The template (a meeting can have its own, from its Summary's
 * menu), whether what people will do comes first, and anything else the person asks for in their own words.
 */
export function SummarySettings() {
  const [style, setStyle] = useState<NotesStyle>()
  const [extra, setExtra] = useState('')
  useEffect(() => { void window.yogurt.settings.get().then((p) => { setStyle(p.notesStyle); setExtra(p.notesStyle.extra) }) }, [])
  const save = (patch: NotesStylePatch) => {
    if (style) setStyle({ ...style, ...patch })
    // main tidies the request (one line, a length limit): what is shown is what is kept
    void window.yogurt.settings.setNotesStyle(patch).then((next) => { if (next) { setStyle(next); if (patch.extra !== undefined) setExtra(next.extra) } })
  }
  return (
    <>
      <h2 className="settings-section-heading">{t('Summary')}</h2>
      <LoadingContent pending={!style} testId="summary-settings-loading"><div data-testid="summary-settings" className="settings-group">
        <div className="settings-row" data-kind="notes-template">
          <span className="settings-permission-icon"><LayoutTemplate size={17} strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="settings-row-copy">
            <label htmlFor="settings-template" className="settings-label">{t('Template')}</label>
            <p className="settings-description">{t('The kind of meeting your summaries are laid out for. A meeting can have its own: pick it from the menu on its Summary.')}</p>
          </div>
          <span className="settings-select-wrap">
            <select id="settings-template" data-testid="settings-template" value={style?.template ?? 'general'} disabled={!style} onChange={(e) => save({ template: e.target.value as Template })} className="settings-select">
              {TEMPLATES.map((v) => <option key={v} value={v}>{templateName(v)}</option>)}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-permission-icon"><ListChecks size={17} strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="settings-row-copy">
            <p className="settings-label">{t('Next steps first')}</p>
            <p className="settings-description">{t('Who will do what goes at the top of the summary.')}</p>
          </div>
          <button data-testid="settings-next-steps-first" role="switch" aria-checked={!!style?.nextStepsFirst} aria-label={t('Next steps first')} className="settings-toggle"
            onClick={() => { if (style) save({ nextStepsFirst: !style.nextStepsFirst }) }}>
            <span className="settings-toggle-knob" />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-permission-icon"><PenLine size={17} strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="settings-row-copy flex flex-col gap-2">
            <div>
              <label htmlFor="settings-notes-extra" className="settings-label">{t('Extra instructions')}</label>
              <p className="settings-description">{t('Anything else you want in every summary, in your own words.')}</p>
            </div>
            <input id="settings-notes-extra" data-testid="settings-notes-extra" dir="auto" value={extra} maxLength={EXTRA_CHARS} disabled={!style}
              placeholder={t('Like: keep it under ten bullets')} onChange={(e) => setExtra(e.target.value)} onBlur={() => { if (style && extra.trim() !== style.extra) save({ extra }) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              className="min-w-0 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-muted" />
          </div>
        </div>
      </div></LoadingContent>
    </>
  )
}
