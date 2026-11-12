import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { Modal, ModalClose } from './Modal'
import { keys, onMac } from '../keys'

export const appShortcuts = () => [
  [t('Meetings'), '⌘1'], [t('Ask'), '⌘2'], [t('Trash'), '⌘3'],
  [t('Search and commands'), '⌘K'], [t('Show or hide Ask Yogurt'), '⌘J'], [t('Settings'), '⌘,'],
  [t('Back'), '⌘['], [t('Forward'), '⌘]'], [t('Copy notes'), '⇧⌘C'], [t('Keyboard shortcuts'), '⌘/'],
].map(([label, mac]) => [label, keys(mac)] as const)

const pc = (rows: readonly (readonly [string, string])[]) => rows.map(([label, mac]) => [label, keys(mac)] as const)

export function Shortcuts({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('')
  const groups = [
    [t('General'), appShortcuts()],
    [t('Search and commands'), [[t('Navigate'), '↑ ↓'], [t('Select'), '↵'], [t('Close'), 'esc']]],
    [t('Transcript'), [[t('Navigate'), '↑ ↓ ↖ ↘'], [t('Play'), '↵ / ␣']]],
    [t('Edit'), pc([[t('Undo'), '⌘Z'], [t('Redo'), '⇧⌘Z'], [t('Cut'), '⌘X'], [t('Copy'), '⌘C'], [t('Paste'), '⌘V'], [t('Paste and Match Style'), '⌥⇧⌘V'], [t('Select All'), '⌘A'], [t('Bold'), '⌘B'], [t('Italic'), '⌘I'], [t('Text formatting'), '⌥F10']])],
    // Hide is the Mac's own
    [t('Window'), pc([[t('Close Window'), '⌘W'], [t('Minimize'), '⌘M'], ...(onMac() ? [[t('Hide {app}', { app: 'Yogurt' }), '⌘H'], [t('Hide Others'), '⌥⌘H']] as const : []), [t('Quit {app}', { app: 'Yogurt' }), '⌘Q']])],
    [t('View'), pc([[t('Toggle Sidebar'), '⌃⌘S'], [t('Actual Size'), '⌘0'], [t('Zoom In'), '⌘+'], [t('Zoom Out'), '⌘−'], [t('Toggle Full Screen'), '⌃⌘F']])],
  ] as const
  const words = query.trim().toLocaleLowerCase().split(/\s+/)
  const matching = groups.map(([group, rows]) => ({ group, rows: rows.filter(([label]) => words.every(word => `${group} ${label}`.toLocaleLowerCase().includes(word))) }))
  return <Modal testId="shortcuts-dialog" title={t('Keyboard shortcuts')} onCancel={onClose}>
    <ModalClose className="workspace-icon shortcuts-close" aria-label={t('Close')}><X size={17} aria-hidden="true" /></ModalClose>
    <label className="shortcuts-search"><Search size={16} aria-hidden="true" /><input data-dialog-focus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search')} aria-label={t('Search')} /></label>
    <div className="shortcuts-list">
      {matching.map(({ group, rows }) => rows.length > 0 && <section key={group}><h3>{group}</h3><dl>{rows.map(([label, keys]) =>
        <div data-testid="shortcut-row" key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}
      </dl></section>)}
      {!matching.some(g => g.rows.length) && <p className="shortcuts-empty">{t('Nothing found for “{query}”.', { query })}</p>}
    </div>
  </Modal>
}
