import { LoadingContent } from './LoadingContent'
import { useEffect, useState } from 'react'
import { ChevronDown, FileText, Languages } from 'lucide-react'
import { NOTES_LANGUAGES, SPOKEN, autonym, type NotesLanguage, type Spoken } from '../../../shared/spoken'
import { t } from '../../../shared/i18n'

const label = (s: Spoken) => (s === 'en' ? t('English only') : s === 'multi' ? t('Multi-language') : autonym(s))

/** The spoken language as a select: in Settings, and on the empty home, where it is seen before the first recording */
export function SpokenSelect({ id, testId }: { id: string; testId: string }) {
  const [spoken, setSpoken] = useState<Spoken>()
  useEffect(() => { void window.yogurt.settings.get().then((p) => setSpoken(p.spoken)) }, [])
  const choose = (v: Spoken) => { setSpoken(v); void window.yogurt.settings.setSpoken(v) }
  return (
    <span className="settings-select-wrap">
      <select id={id} data-testid={testId} value={spoken ?? 'en'} disabled={!spoken} onChange={(e) => choose(e.target.value as Spoken)} className="settings-select">
        {/* a language in its own name, so anyone can find theirs */}
        {SPOKEN.map((v) => <option key={v} value={v} lang={v === 'en' || v === 'multi' ? undefined : v}>{label(v)}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  )
}

/** Settings → Language: the language people speak in meetings, the same choice as the picker under a note */
export function SpokenSetting() {
  return (
    <div className="settings-row" data-kind="spoken">
      <span className="settings-permission-icon"><Languages size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-spoken" className="settings-label">{t('Spoken language')}</label>
        <p className="settings-description">{t('Pick the language of your meetings. Multi-language listens for whichever is spoken.')}</p>
      </div>
      <SpokenSelect id="settings-spoken" testId="settings-spoken" />
    </div>
  )
}

/** Settings → Language: the language notes are written in, each meeting's own unless one is picked */
export function NotesLanguageSetting() {
  const [language, setLanguage] = useState<NotesLanguage | ''>()
  useEffect(() => { void window.yogurt.settings.get().then((p) => setLanguage(p.notesLanguage)) }, [])
  const choose = (v: NotesLanguage | '') => { setLanguage(v); void window.yogurt.settings.setNotesLanguage(v) }
  return (
    <LoadingContent pending={language === undefined}><div className="settings-row" data-kind="notes-language">
      <span className="settings-permission-icon"><FileText size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-notes-language" className="settings-label">{t('Notes language')}</label>
        <p className="settings-description">{t('The language your notes are written in.')}</p>
      </div>
      <span className="settings-select-wrap">
      <select id="settings-notes-language" data-testid="settings-notes-language" value={language ?? ''} disabled={language === undefined} onChange={(e) => choose(e.target.value as NotesLanguage | '')} className="settings-select">
        <option value="">{t('Same as the meeting')}</option>
        {NOTES_LANGUAGES.map((v) => <option key={v} value={v} lang={v}>{autonym(v)}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}
