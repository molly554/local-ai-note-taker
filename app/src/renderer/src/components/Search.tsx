import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog'
import { useReducedMotion } from 'motion/react'
import { MotionPopup } from './MotionPopup'
import { surfaceMotion } from '../motion'
import { FolderGlyph } from './FolderAppearance'
import { useEffect, useRef, useState } from 'react'
import { AudioLines, FileText, FolderIcon, Keyboard, LogIn, MessageCircle, Monitor, Moon, PanelLeft, Search as SearchIcon, Settings, Sun, Trash2, X } from 'lucide-react'
import type { SearchResult, SnippetPart, Folder } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { keys, osWords } from '../keys'
import { markWords } from '../../../shared/highlight'
import { dayLabel } from '../dates'

/** typing settles this long before the search runs */
const DEBOUNCE_MS = 120

/** Pieces of text with the matched words marked: React text nodes only, so nothing in a note can run as markup */
function Marked({ parts }: { parts: SnippetPart[] }) {
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="search-mark">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>
}

/**
 * ⌘K searches meetings and the app's destinations and actions. A folder scopes meeting results only.
 */
export function Search({ folder, folders, onOpen, onNavigate, onSettingsChange, onShortcuts, onClose, sidebarCollapsed, onToggleSidebar }: {
  folder?: Folder; folders?: Folder[]; onOpen: (id: string) => void; onNavigate: (route: string) => void; onSettingsChange: () => void; onShortcuts: () => void; onClose: () => void
  sidebarCollapsed: boolean; onToggleSidebar: () => void
}) {
  const [open, setOpen] = useState(true)
  const reduce = useReducedMotion()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => close.current(), reduce ? 0 : surfaceMotion.exitHoldMs)
    return () => clearTimeout(timer)
  }, [open, reduce])
  const [q, setQ] = useState('')
  const [scope, setScope] = useState(folder)
  const [results, setResults] = useState<{ q: string; scopeId?: string; list: SearchResult[] }>()
  const [active, setActive] = useState(0)
  const [prefs, setPrefs] = useState<Awaited<ReturnType<typeof window.yogurt.settings.get>>>()
  const [error, setError] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => { void window.yogurt.settings.get().then(setPrefs) }, [])
  const seq = useRef(0)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const mine = ++seq.current
    const run = () => void window.yogurt.search.query(q, scope?.id).then((list) => {
      // an answer to an older question never replaces a newer one
      if (mine !== seq.current) return
      setResults({ q, scopeId: scope?.id, list }); setActive(0)
    })
    if (!q.trim()) { run(); return }
    const timer = setTimeout(run, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q, scope])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  // focus goes back where it was when search closes: read during the first render, before the input takes it
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => { seq.current++; if (before?.isConnected) before.focus({ preventScroll: true }) }, [before])
  const input = useRef<HTMLInputElement>(null)

  // Keep one coherent result set on screen until the next search is ready.
  const typed = (results?.q ?? '').trim()
  const settled = results?.q === q && results?.scopeId === scope?.id
  const items = results?.list ?? []
  const navigate = (route: string) => { onNavigate(route) }
  const settingsAction = async (run: () => Promise<void>) => { await run(); onSettingsChange() }
  const allCommands = [
    { id: 'meetings', label: t('Meetings'), group: t('Go to'), Icon: FileText, run: () => navigate(''), shortcut: keys('⌘1') },
    { id: 'chat', label: t('Ask'), group: t('Go to'), Icon: MessageCircle, run: () => navigate('/chat'), shortcut: keys('⌘2') },
    { id: 'trash', label: t('Trash'), group: t('Go to'), Icon: Trash2, run: () => navigate('/trash'), shortcut: keys('⌘3') },
    { id: 'settings', label: t('Settings'), group: t('Go to'), Icon: Settings, run: () => navigate('/settings'), shortcut: keys('⌘,') },
    { id: 'shortcuts', label: t('Keyboard shortcuts'), group: t('Go to'), Icon: Keyboard, run: onShortcuts, shortcut: keys('⌘/') },
    { id: 'sidebar', label: sidebarCollapsed ? t('Show Sidebar') : t('Hide Sidebar'), group: t('View'), Icon: PanelLeft, run: onToggleSidebar, shortcut: keys('⌃⌘S') },
    ...(folders ?? []).map((f) => ({ id: `folder-${f.id}`, label: f.name, group: t('Folders'), Icon: FolderIcon, folder: f, run: () => navigate(`/folder/${f.id}`) })),
    { id: 'theme-light', label: t('Light theme'), group: t('Appearance'), Icon: Sun, run: () => settingsAction(() => window.yogurt.settings.setTheme('light')) },
    { id: 'theme-dark', label: t('Dark theme'), group: t('Appearance'), Icon: Moon, run: () => settingsAction(() => window.yogurt.settings.setTheme('dark')) },
    { id: 'theme-system', label: osWords({ mac: t('Match my Mac'), windows: t('Match Windows'), linux: t('Match my system') }), group: t('Appearance'), Icon: Monitor, run: () => settingsAction(() => window.yogurt.settings.setTheme('system')) },
    ...(prefs ? [
      { id: 'login', label: prefs.openAtLogin ? t('Turn off open at login') : t('Open Yogurt at login'), group: t('Settings'), Icon: LogIn, run: () => settingsAction(() => window.yogurt.settings.setOpenAtLogin(!prefs.openAtLogin)) },
      { id: 'auto-stop', label: prefs.stopWhenCallEnds ? t('Keep recording when the call ends') : t('Finish recording when the call ends'), group: t('Settings'), Icon: AudioLines, run: () => settingsAction(() => window.yogurt.settings.setStopWhenCallEnds(!prefs.stopWhenCallEnds)) },
    ] : []),
  ].filter((c) => !c.id.startsWith('theme-') || (!!prefs && c.id !== `theme-${prefs.theme}`))
  const matchingCommands = (query: string) => allCommands.filter((c) => query.trim().toLocaleLowerCase().split(/\s+/).every((word) => `${c.label} ${c.group}`.toLocaleLowerCase().includes(word)))
  const commands = matchingCommands(typed)
  const count = items.length + commands.length
  const runCommand = async (command: typeof commands[number]) => {
    if (running) return
    setRunning(true); setError(false)
    try { await command.run(); setOpen(false) } catch { setError(true); setRunning(false) }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(Math.max(0, count - 1), a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); enter() }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab') {
      e.preventDefault()
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input, button'))
      const at = controls.indexOf(document.activeElement as HTMLElement)
      controls[(at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    }
  }
  /** what is shown answers what is typed: open the one picked; typed faster than the search: ask now and open its first */
  const enter = () => {
    if (settled) {
      const r = items[active], command = commands[active - items.length]
      if (r) onOpen(r.meetingId)
      else if (command) void runCommand(command)
      return
    }
    const mine = ++seq.current
    void window.yogurt.search.query(q, scope?.id).then((list) => {
      if (mine !== seq.current) return
      const command = matchingCommands(q)[0]
      if (list[0]) onOpen(list[0].meetingId)
      else if (command) void runCommand(command)
      else { setResults({ q, scopeId: scope?.id, list }); setActive(0) }
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal keepMounted>
      <Dialog.Backdrop className="search-backdrop no-drag fixed inset-0 z-[100]" transition={{ duration: reduce ? 0 : .2 }} exitTransition={{ duration: reduce ? 0 : surfaceMotion.exitMs / 1000 }} />
      <MotionPopup open={open} reduced={!!reduce} initialFocus={input} finalFocus={() => before} data-testid="search" role="dialog" aria-modal="true" aria-label={t('Search and commands')} onKeyDown={onKeyDown}
        // a click anywhere in the panel keeps typing, arrows and Esc in the search box
        onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus() } }}
        className="search-panel flex max-h-[74vh] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-line bg-float">
        <div className="search-input-row flex shrink-0 items-center gap-3 px-5">
          <SearchIcon size={21} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-muted" />
          {scope && <span data-testid="search-scope" className="note-chip flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-line ps-2.5 pe-1 text-[13px] text-muted">
            <FolderGlyph appearance={scope} size={14} /><span className="truncate">{scope.name}</span>
            <button data-testid="search-scope-clear" onClick={() => { setScope(undefined); input.current?.focus() }} aria-label={t('Search all meetings')} title={t('Search all meetings')}
              className="grid size-5 shrink-0 place-items-center rounded hover:text-ink"><X size={13} aria-hidden="true" /></button>
          </span>}
          <input
            data-testid="search-input" ref={input} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); setError(false) }}
            placeholder={t('Search meetings or run a command…')} aria-label={t('Search')} spellCheck={false}
            role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={items[active] ? `search-${items[active].meetingId}` : commands[active - items.length] ? `command-${commands[active - items.length].id}` : undefined}
            className="h-[58px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
          <kbd className="search-key shrink-0">esc</kbd>
        </div>
        <ul ref={list} id="search-results" role="listbox" aria-label={t('Results')} aria-busy={running || !settled} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
              {items.length > 0 && <li role="presentation" className="command-section">{typed ? t('Meetings') : t('Recent meetings')}</li>}
              {items.map((r, i) => (
                <li
                  key={r.meetingId} id={`search-${r.meetingId}`} data-testid="search-result" role="option" aria-selected={i === active}
                  onMouseMove={() => setActive(i)} onClick={() => onOpen(r.meetingId)}
                  className="search-row flex cursor-default items-start gap-3.5 rounded-md px-3 py-2.5"
                >
                  <span className="search-result-icon"><FileText size={17} strokeWidth={1.6} aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-4">
                      <span data-testid="search-result-title" className="truncate text-[13px] font-medium leading-5"><Marked parts={markWords(r.title, typed)} /></span>
                      <span className="shrink-0 text-[11px] text-muted">{dayLabel(r.startedAt)}</span>
                    </span>
                    {typed && r.parts.length > 0 && <span className="mt-0.5 line-clamp-1 text-[13px] leading-relaxed text-muted"><Marked parts={r.parts} /></span>}
                  </span>
                </li>
              ))}
              {commands.map((c, i) => <li key={c.id} role="presentation">
                {(i === 0 || commands[i - 1].group !== c.group) && <p className="command-section">{c.group}</p>}
                <div id={`command-${c.id}`} data-testid={`command-${c.id}`} role="option" aria-selected={active === items.length + i} aria-disabled={running}
                  onMouseMove={() => setActive(items.length + i)} onClick={() => void runCommand(c)} className="search-row command-row">
                  {'folder' in c ? <FolderGlyph appearance={c.folder} /> : <c.Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
                  <span className="command-label">{c.label}</span>{'shortcut' in c && <kbd className="search-key">{c.shortcut}</kbd>}
                </div>
              </li>)}
        {results && !count && (
          <li role="presentation" data-testid="search-none" className="flex h-full items-center justify-center px-5 py-8 text-center text-sm text-muted">
            {typed ? t('Nothing found for “{query}”.', { query: typed }) : scope ? t('No meetings in this folder yet.') : t('No notes yet.')}
          </li>
        )}
        </ul>
        {error && <p role="alert" className="px-5 pb-3 text-xs text-danger">{t("Yogurt couldn't make that change. Try again.")}</p>}
        <div className="search-footer">
          <span><kbd className="search-key">↑</kbd><kbd className="search-key">↓</kbd>{t('Navigate')}</span>
          <span><kbd className="search-key">↵</kbd>{t('Select')}</span>
          <button data-testid="search-shortcuts" onClick={onShortcuts}><Keyboard size={14} aria-hidden="true" />{t('Keyboard shortcuts')}<kbd className="search-key">{keys('⌘/')}</kbd></button>
        </div>
      </MotionPopup>
    </Dialog.Portal>
    </Dialog.Root>
  )
}
