import { AudioLines, TextAlignStart } from 'lucide-react'
import { t } from '../../../shared/i18n'

const Bar = ({ width = '60%' }: { width?: string }) => <span className="loading-bar" style={{ width }} />

/** Placeholders use the reading surface's own rows, bubbles, padding and type line boxes. */
export function Loading({ layout, testId = `${layout}-loading` }: {
  layout: 'note' | 'chat' | 'history' | 'transcript' | 'folders' | 'calendars'; testId?: string
}) {
  return <div data-testid={testId} className={`page-loading loading-${layout}`} role="status" aria-label={t('Loading…')} aria-busy="true">
    <div aria-hidden="true" inert>
      {layout === 'note' ? <>
        <header className="note-header note-page-width">
          <div className="note-title-type"><Bar width="52%" /></div>
          <div className="note-meta-row"><div className="note-metadata">{[100, 130, 110].map(w => <span key={w} className="loading-note-chip" style={{ width: w }} />)}</div></div>
          <div className="note-primary-tabs"><button role="tab" disabled><AudioLines size={14} />{t('Transcript')}</button><button role="tab" disabled><TextAlignStart size={14} />{t('My notes')}</button></div>
        </header>
        <div className="note-page-width note-notes-body"><div className="loading-prose">{['48%', '82%', '72%'].map(w => <Bar key={w} width={w} />)}</div></div>
      </> : layout === 'history' ? <section><h2><Bar width="48px" /></h2><ul>{[0, 1, 2].map(n => <li className="ask-history-row" key={n}><div className="ask-history-link"><strong><Bar width={`${130 + n * 14}px`} /></strong><time><Bar width="56px" /></time></div></li>)}</ul></section>
        : layout === 'folders' ? <div className="workspace-folder-list">{[0, 1, 2].map(n => <div className="workspace-nav" key={n}><span className="loading-folder-icon" /><Bar width={`${70 + n * 12}px`} /></div>)}</div>
        : layout === 'calendars' ? <>{[0, 1].map(n => <div className="settings-row settings-calendar-choice" key={n}><span className="settings-calendar-dot loading-bar" /><span className="settings-row-copy"><span className="settings-label"><Bar width="120px" /></span><span className="settings-description block"><Bar width="90px" /></span></span><span className="loading-checkbox" /></div>)}</>
        : layout === 'transcript' ? <div className="loading-transcript-turns">{[0, 1, 2].map(n => <div key={n} className={`transcript-turn flex flex-col gap-[5px] ${n === 1 ? 'items-end' : 'items-start'}`}><p className={n === 1 ? 'sr-only' : 'turn-head flex items-baseline gap-2 px-1 text-xs'}><Bar width="42px" /></p><p className={`bubble ${n === 1 ? 'bubble-me' : 'bubble-them'}`}><Bar width={`${160 + n * 25}px`} /></p></div>)}</div>
        : <div className="ask-turn"><p className="ask-question"><Bar width="160px" /></p><div className="loading-prose">{['48%', '82%', '72%'].map(w => <Bar key={w} width={w} />)}</div></div>}
    </div>
  </div>
}
