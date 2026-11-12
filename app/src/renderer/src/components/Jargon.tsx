import { LoadingContent } from './LoadingContent'
import { useEffect, useRef, useState } from 'react'
import { BookA, Plus, X } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { addTerm, MAX_TERM, MAX_TERMS } from '../../../shared/jargon'

/** Settings → Language: names, products and acronyms the person wants spelled right. Enter adds, Backspace in the empty field takes the last one off */
export function Jargon() {
  const [loaded, setLoaded] = useState(false)
  const [terms, setTerms] = useState<string[]>([])
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { void window.yogurt.settings.get().then((p) => { setTerms(p.jargon); setLoaded(true) }) }, [])
  // main cleans the list the same way, so what is shown is what is saved
  const save = (next: string[]) => { setTerms(next); void window.yogurt.settings.setJargon(next) }
  const next = addTerm(terms, text)
  const fresh = next !== terms
  const full = terms.length >= MAX_TERMS
  const add = () => {
    if (fresh) save(next)
    // a term already there is let go (its chip is right there); with the list full, what was typed stays
    if (fresh || (text.trim() && !full)) setText('')
    input.current?.focus()
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); add() }
    else if (e.key === 'Escape' && text) { e.preventDefault(); setText('') }
    else if (e.key === 'Backspace' && !text && terms.length) { e.preventDefault(); save(terms.slice(0, -1)) }
  }
  return (
    <LoadingContent pending={!loaded}><div className="settings-row">
      <span className="settings-permission-icon"><BookA size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="jargon-input" className="settings-label">{t('Personal jargon')}</label>
        <p className="settings-description">{t('Names, products, and acronyms you want Yogurt to spell right in your transcripts and notes.')}</p>
        <div data-testid="jargon-field" className="settings-jargon-field" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus() } }}>
          {terms.map((term) => (
            <span key={term.toLowerCase()} data-testid="jargon-chip" className="settings-jargon-chip">
              <span dir="auto">{term}</span>
              <button type="button" aria-label={t('Remove {name}', { name: term })} onClick={() => { save(terms.filter((x) => x !== term)); input.current?.focus() }} className="settings-jargon-remove">
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input ref={input} id="jargon-input" data-testid="jargon-input" value={text} maxLength={MAX_TERM + 20} autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded={fresh} aria-controls="jargon-suggestions" aria-autocomplete="list" aria-activedescendant={fresh ? 'jargon-suggest' : undefined}
            placeholder={full ? t('Your list is full. Remove a term to add another.') : t('Add a term and press Enter')}
            onChange={(e) => setText(e.target.value)} onKeyDown={keys} className="settings-jargon-input" />
          <ul id="jargon-suggestions" role="listbox" aria-label={t('Personal jargon')} hidden={!fresh} className="settings-jargon-suggest">
            {fresh && (
              // keeps the field focused, so the next term can be typed straight away
              <li id="jargon-suggest" data-testid="jargon-suggest" role="option" aria-selected="true" onMouseDown={(e) => e.preventDefault()} onClick={add} className="settings-jargon-option">
                <Plus size={14} aria-hidden="true" className="shrink-0 text-muted" />
                <span dir="auto" className="truncate">{t('Add "{term}"', { term: next.at(-1)! })}</span>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div></LoadingContent>
  )
}
