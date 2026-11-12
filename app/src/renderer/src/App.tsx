import { LoadingContent } from './components/LoadingContent'
import { MeetingListLoading } from './screens/Home'
import { StartRecording } from './components/StartRecording'
import { useEffect, useRef, useState } from 'react'
import { rememberScrollPositions } from './useScrollMemory'
import { flushOpenNotes, handoffOpenNotes } from './noteAutosave'
import { Onboarding } from './screens/Onboarding'
import { Note } from './screens/Note'
import { Home } from './screens/Home'
import { Settings } from './screens/Settings'
import { Shortcuts } from './components/Shortcuts'
import { Search } from './components/Search'
import { Workspace } from './components/Workspace'
import { command, onMac } from './keys'
import { TrashToast } from './components/TrashToast'
import { Trash } from './screens/Trash'
import { ChatPage } from './screens/ChatPage'
import { BootScreen } from './components/BootScreen'
import { bootHoldMs } from '../../shared/onboarding'
import { Folder } from './screens/Folder'
import { useFolders } from './folders'
import type { LibrarySource, MeetingView, OnboardingPlan, SetupState } from '../../shared/types'

export function App() {
  useEffect(() => {
    const off = window.yogurt.notes.onFlushRequest((closing) => {
      // No new typing between a graceful quit's final flush and window teardown.
      document.body.inert = closing
      return closing ? flushOpenNotes() : Promise.resolve(true)
    })
    // Main retains a failed final edit even after this renderer closes or reloads.
    const handoff = (e: BeforeUnloadEvent) => {
      // A failed database write is retained in main. A failed IPC handoff must keep this renderer alive.
      if (!handoffOpenNotes()) { e.preventDefault(); e.returnValue = '' }
    }
    const hidden = () => { if (document.visibilityState === 'hidden') void flushOpenNotes() }
    window.addEventListener('beforeunload', handoff)
    document.addEventListener('visibilitychange', hidden)
    return () => { off(); window.removeEventListener('beforeunload', handoff); document.removeEventListener('visibilitychange', hidden) }
  }, [])
  const [setup, setSetup] = useState<SetupState>()
  // where the app was told to go, e.g. /note/<id>
  const [route, setRouteNow] = useState('')
  const [meeting, setMeeting] = useState<Pick<MeetingView, 'id' | 'title'>>()
  /** Back and forward keep the same note routes; a new destination starts a new branch. */
  const history = useRef<string[]>([])
  const future = useRef<string[]>([])
  const echoes = useRef<string[]>([])
  const routeRef = useRef('')
  const setRoute = (r: string) => {
    rememberScrollPositions()
    if (r !== routeRef.current) { history.current = [...history.current, routeRef.current].slice(-50); future.current = [] }
    routeRef.current = r
    setRouteNow(r)
  }
  const rememberRoute = (r: string) => { echoes.current.push(r); window.yogurt.nav.go(r) }
  const go = (r: string) => { setRoute(r); rememberRoute(r) }
  const back = () => {
    const prev = history.current.pop()
    if (prev === undefined) return
    rememberScrollPositions()
    future.current.push(routeRef.current)
    routeRef.current = prev; setRouteNow(prev); rememberRoute(prev)
  }
  const forward = () => {
    const next = future.current.pop()
    if (next === undefined) return
    rememberScrollPositions()
    history.current.push(routeRef.current)
    routeRef.current = next; setRouteNow(next); rememberRoute(next)
  }
  useEffect(() => {
    // a go-to that arrives while the first ask is on its way wins over the older answer
    let told = false
    const off = window.yogurt.nav.onGo((r) => {
      told = true
      // Main echoes our moves for persistence; delayed echoes must not create new history entries.
      if (echoes.current[0] === r) { echoes.current.shift(); return }
      setRoute(r)
    })
    void window.yogurt.nav.current().then((r) => { if (!told) { routeRef.current = r; setRouteNow(r) } })
    return off
  }, [])
  useEffect(() => {
    const stop = window.yogurt.setup.onState(setSetup)
    void window.yogurt.setup.state().then((s) => setSetup((cur) => cur ?? s))
    return stop
  }, [])

  // first run: the intro and the questions still to ask; nothing on later launches
  const [plan, setPlan] = useState<OnboardingPlan>()
  useEffect(() => { void window.yogurt.onboarding.plan().then(setPlan, () => setPlan({ intro: false, steps: [] })) }, [])
  const firstRunDone = !!plan && !plan.intro && plan.steps.length === 0
  const ready = setup?.phase === 'ready' && firstRunDone
  // the launch screen: up while Yogurt starts, and once it has shown, long enough to be seen
  // a later launch also waits for the models on disk to be checked
  const booted = !!setup && !!plan && !(setup.phase === 'checking' && firstRunDone)
  const [holding, setHolding] = useState(true)
  useEffect(() => {
    if (!booted) return
    const ms = bootHoldMs(performance.now())
    if (!ms) { setHolding(false); return }
    const timer = setTimeout(() => setHolding(false), ms)
    return () => clearTimeout(timer)
  }, [booted])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 900)
  const [sidebarMotion, setSidebarMotion] = useState(false)
  const toggleSidebar = (animate = false) => { setSidebarMotion(animate); setSidebarCollapsed(value => !value) }
  useEffect(() => {
    // Close it only when the window narrows past 900px, so later resizes keep a sidebar the person opened.
    let wide = window.innerWidth >= 900
    const resize = () => {
      setSidebarMotion(false)
      if (wide && window.innerWidth < 900) setSidebarCollapsed(true)
      wide = window.innerWidth >= 900
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => { window.yogurt.sidebar.setOpen(ready && !holding ? !sidebarCollapsed : null) }, [ready, holding, sidebarCollapsed])
  useEffect(() => {
    if (!ready || holding) return
    return window.yogurt.sidebar.onToggle(() => {
      if (!document.querySelector('dialog:modal, [aria-modal="true"]')) toggleSidebar()
    })
  }, [ready, holding])
  const [shortcuts, setShortcuts] = useState(false)
  const openShortcuts = () => { setSearching(false); setShortcuts(true) }
  const [searching, setSearching] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const folders = useFolders()
  const [suggestedFolders, setSuggestedFolders] = useState<Record<string, string>>({})
  const dismissFolderSuggestion = (id: string) => setSuggestedFolders((current) => {
    const next = { ...current }; delete next[id]; return next
  })
  // ⌘K from any screen, also while typing in a note; by the key's place, so it works with any keyboard layout
  useEffect(() => {
    if (!ready || holding) return
    const onKey = (e: KeyboardEvent) => {
      // a Mac's ⌃⌘S is Ctrl+Shift+S on Windows and Linux
      const mac = onMac()
      if (e.isComposing || !command(e) || e.altKey || (mac && e.shiftKey) || document.querySelector('dialog:modal, .app-modal[aria-modal="true"]')) return
      if (mac ? e.ctrlKey : e.shiftKey) {
        if (e.code === 'KeyS' && !document.querySelector('[aria-modal="true"]')) {
          e.preventDefault(); e.stopPropagation(); if (!e.repeat) toggleSidebar()
        }
        return
      }
      if (e.code === 'KeyK') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) setSearching((s) => !s); return }
      if (e.code === 'Slash') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) openShortcuts(); return }
      const destinations: Record<string, string> = { Digit1: '', Digit2: '/chat', Digit3: '/trash', Comma: '/settings' }
      if (e.code in destinations && !document.querySelector('[aria-modal="true"]:not([data-testid="search"])')) {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) { setSearching(false); go(destinations[e.code]) }
        return
      }
      if (document.querySelector('[aria-modal="true"]')) return
      if (e.code === 'BracketLeft') { e.preventDefault(); back() }
      if (e.code === 'BracketRight') { e.preventDefault(); forward() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ready, holding])
  const open = (id: string) => { setSearching(false); go(`/note/${id}`) }
  /** A citation opens its matching notes paragraph or transcript segment. */
  const [jump, setJump] = useState<{ id: string; ms: number | null; match?: string; seq: number }>()
  const openSource = (s: LibrarySource, match?: string) => {
    setJump((cur) => ({ id: s.meetingId, ms: s.atMs, match, seq: (cur?.seq ?? 0) + 1 }))
    open(s.meetingId)
  }

  // still starting, or checking what is on disk: the launch screen, so a finished install never flashes the first-run screen
  if (!setup || !plan || holding) return <div data-testid="app-shell" className="h-full bg-bg"><TitleBar /><BootScreen /></div>
  const noteId = route.startsWith('/note/') ? route.slice(6) : null
  const settings = route === '/settings'
  const trash = route === '/trash'
  const chatId = route === '/chat' ? null : route.startsWith('/chat/') ? route.slice(6) : undefined
  const folderId = route.startsWith('/folder/') ? route.slice('/folder/'.length) : null
  const folder = folderId ? folders?.find((s) => s.id === folderId) : undefined
  const suggestedFolder = noteId ? folders?.find((s) => s.id === suggestedFolders[noteId]) : undefined
  // a folder's page waits for the list; a folder that is gone shows Meetings
  const folderScreen = folderId && (folder ? <Folder key={folder.id} folder={folder} open={open} onStarted={(id) => setSuggestedFolders((current) => ({ ...current, [id]: folder.id }))} /> : !folders ? <div className="native-folder"><StartRecording /><div className="native-library"><LoadingContent pending testId="meetings-loading" skeleton={<><div className="folder-page-heading"><h1><span className="loading-bar" style={{ width: 140 }} /></h1></div><MeetingListLoading showFolders={false} /></>} /></div></div> : null)
  const screen = settings ? <Settings revision={settingsRevision} /> : noteId ? <Note key={noteId} id={noteId} onSource={openSource} onTitleChange={setMeeting} at={jump?.id === noteId ? jump : undefined}
    folderSuggestion={suggestedFolder ? { folder: suggestedFolder, dismiss: () => dismissFolderSuggestion(noteId) } : undefined} />
    : chatId !== undefined ? <ChatPage id={chatId} go={go} openSource={openSource} />
    : trash ? <Trash open={open} /> : folderScreen || <Home open={open} openFolder={(id) => go(`/folder/${id}`)} />
  return (
    <div data-testid="app-shell" className={`h-full text-ink ${ready ? 'bg-transparent' : 'bg-bg'}`}>
      {ready ? <Workspace route={route} meeting={meeting} folders={folders} go={go} back={history.current.length ? back : undefined} forward={future.current.length ? forward : undefined} search={() => setSearching(true)} collapsed={sidebarCollapsed} sidebarMotion={sidebarMotion} toggleSidebar={toggleSidebar}>{screen}</Workspace>
        : <><TitleBar />{setup.phase === 'checking' && firstRunDone ? <BootScreen /> : <Onboarding state={setup} plan={plan} onDone={() => setPlan({ intro: false, steps: [] })} />}</>}
      {ready && searching && <Search folder={folder} folders={folders} onOpen={open} onNavigate={go} onShortcuts={openShortcuts} onSettingsChange={() => setSettingsRevision((v) => v + 1)} onClose={() => setSearching(false)} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => toggleSidebar()} />}
      {ready && shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      {ready && <TrashToast go={go} />}
    </div>
  )
}

/** Keep the native traffic-light strip clear during setup; draggable, and the page's own colour so first run reads as one surface. */
function TitleBar() {
  return <div data-testid="titlebar" className="drag fixed inset-x-0 top-0 z-50 h-12" />
}
