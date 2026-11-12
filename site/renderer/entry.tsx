import './bridge.mjs'
import { FragmentScene } from './fragments'
import { fragment } from './bridge.mjs'
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Note } from '@app/screens/Note'
import { Workspace } from '@app/components/Workspace'
import '@app/styles.css'
import '@app/workspace.css'
import './frame.css'
import { meeting, folders, ready, onReset } from './bridge.mjs'
const noop = () => {}
document.documentElement.classList.add('main-window')
document.documentElement.dataset.marketingTheme = fragment ? 'light' : 'dark'
if (fragment) document.documentElement.dataset.fragment = fragment
function Scene() {
  const [revision, setRevision] = useState(0)
  useEffect(() => onReset(() => setRevision(value => value + 1)), [])
  useEffect(() => ready(), [revision])
  return <><div className="marketing-window"><Workspace route={`/note/${meeting.id}`} meeting={meeting} folders={folders} go={noop}
    search={noop} collapsed={matchMedia('(max-width:600px)').matches} sidebarMotion={false} toggleSidebar={noop}>
    <Note key={revision} id={meeting.id} onTitleChange={noop} />
  </Workspace><div className="marketing-traffic"><i/><i/><i/></div></div><svg className="marketing-cursor" viewBox="0 0 30 32" aria-hidden="true"><circle className="cursor-ring" cx="4" cy="3" r="12"/><path className="cursor-pointer" d="M4 3 24 13 15.1 15.7 11.3 25Z" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"/></svg></>
}
createRoot(document.getElementById('root')!).render(fragment ? <FragmentScene /> : <Scene />)
