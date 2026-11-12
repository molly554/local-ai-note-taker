import { FileText, Folder, X } from 'lucide-react'
import type { ContextTarget } from '../../../shared/askContext'
import { t } from '../../../shared/i18n'

export const chipTitle = (c: ContextTarget) => c.title.trim() || (c.kind === 'meeting' ? t('Untitled meeting') : t('Folder'))

export function AskContext({ chips, disabled, onRemove }: {
  chips: ContextTarget[]; disabled: boolean; onRemove: (chip: ContextTarget) => void
}) {
  if (!chips.length) return null
  return <div className="ask-context-strip" data-testid="ask-composer-context">
    {chips.map(c => <div className="ask-context-row" key={`${c.kind}:${c.id}`} title={chipTitle(c)}>
      {c.kind === 'meeting' ? <FileText size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
      <span>{chipTitle(c)}</span>
      <button type="button" className="chat-icon" disabled={disabled} aria-label={`${t('Remove')} ${chipTitle(c)}`} title={t('Remove')} onClick={() => onRemove(c)}><X size={12} aria-hidden="true" /></button>
    </div>)}
  </div>
}
