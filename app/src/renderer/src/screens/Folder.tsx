import { Folder as FolderIcon } from 'lucide-react'
import { LoadingContent } from '../components/LoadingContent'
import { MeetingListLoading } from './Home'
import { useEffect, useRef, useState } from 'react'
import { FolderGlyph } from '../components/FolderAppearance'
import { FolderAppearanceDialog } from '../components/FolderDialogs'
import type { Folder as FolderRow } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { useDay } from '../dates'
import { PastNotes, usePastNotes } from './Home'
import { StartRecording } from '../components/StartRecording'

/** A folder's page: its name (click to rename) and its meetings, newest first, as on Meetings */
export function Folder({ folder, open, onStarted }: { folder: FolderRow; open: (id: string) => void; onStarted: (id: string) => void }) {
  const [appearance, setAppearance] = useState(false)
  const past = usePastNotes(folder.id)
  const day = useDay()
  return <div data-testid="folder-page" className="native-folder">
    <StartRecording onStarted={onStarted} />
    <div className="native-library" ref={past.setRoot}>
      <div className="folder-page-heading"><button className="folder-heading-icon" data-testid="folder-heading-icon" aria-label={t('Change icon')} title={t('Change icon')} onClick={() => setAppearance(true)} data-folder-color={folder.color}><FolderGlyph appearance={folder} size={24} /></button><FolderTitle folder={folder} /></div>
      {appearance && <FolderAppearanceDialog folder={folder} onDone={() => setAppearance(false)} />}
      <LoadingContent pending={!past.cards} testId="meetings-loading" skeleton={<MeetingListLoading showFolders={false} />} className="library-load">{!past.cards?.length ? <section data-testid="folder-empty" className="library-empty empty-state"><div className="empty-state-content">
        <div className="empty-tile"><FolderIcon size={28} strokeWidth={1.5} aria-hidden="true" /></div><h2>{t('No meetings here yet')}</h2>
        <p>{t('Start recording here, drag a meeting from Meetings, or add one from its note.')}</p>
      </div></section> : <PastNotes showFolders={false} cards={past.cards ?? []} day={day} more={past.more} sentinel={past.setSentinel} onOpen={open} />}</LoadingContent>
    </div>
  </div>
}

/** The folder's name as the page heading: click to rename; Return or clicking away saves, Escape keeps the old one */
function FolderTitle({ folder }: { folder: FolderRow }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(folder.name)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { setDraft(folder.name); cancelled.current = false } }, [editing, folder.name])
  if (!editing) {
    return <h1 data-testid="folder-title"><button onClick={() => setEditing(true)} title={t('Rename')} className="note-title-btn -mx-1 max-w-full rounded-lg px-1 text-start">{folder.name}</button></h1>
  }
  const done = () => {
    setEditing(false)
    if (!cancelled.current && draft.trim() && draft.trim() !== folder.name) void window.yogurt.folders.rename(folder.id, draft)
  }
  return <h1><input data-testid="folder-title-input" aria-label={t('Folder name')} autoFocus value={draft} maxLength={200}
    onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={done}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() } }}
    className="-mx-1 w-full rounded-lg bg-transparent px-1 outline-none ring-1 ring-line focus:ring-accent" /></h1>
}
