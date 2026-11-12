import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowDown, ArrowUp, Ellipsis, Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import { Reorder, useDragControls, useReducedMotion } from 'motion/react'
import type { Folder } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { FolderGlyph } from './FolderAppearance'
import { MEETING_DRAG } from '../folders'
import { DeleteFolder, FolderName, FolderAppearanceDialog } from './FolderDialogs'
import { toasts } from './TrashToast'

/**
 * The sidebar's folders: each opens its page, takes a meeting row dropped on it, and has a small menu to rename or
 * delete it; New folder at the end.
 */
export function FoldersNav({ folders, route, go, collapsed = false }: { collapsed?: boolean; folders?: Folder[]; route: string; go: (route: string) => void }) {
  const [naming, setNaming] = useState<{ folder?: Folder }>()
  const [appearance, setAppearance] = useState<Folder>()
  const [deleting, setDeleting] = useState<Folder>()
  const [order, setOrder] = useState<string[]>()
  const [busy, setBusy] = useState(false)
  const dragging = useRef(false)
  const group = useRef<HTMLDivElement>(null)
  const ids = order ? [...order.filter(id => folders?.some(f => f.id === id)), ...(folders ?? []).filter(f => !order.includes(f.id)).map(f => f.id)] : (folders ?? []).map(f => f.id)
  const latest = useRef(ids)
  latest.current = ids
  useEffect(() => { if (!dragging.current && !busy) setOrder(undefined) }, [folders])
  const save = async (next: string[]) => {
    dragging.current = false
    if (next.every((id, i) => id === folders?.[i]?.id)) { setOrder(undefined); return }
    setOrder(next); setBusy(true)
    try {
      if (!await window.yogurt.folders.reorder(next)) throw new Error('Folder list changed')
    } catch {
      setOrder(undefined)
      toasts.add({ title: t("Yogurt couldn't make that change. Try again.") })
    } finally { setBusy(false) }
  }
  const move = (id: string, step: number) => {
    const at = ids.indexOf(id), next = [...ids]
    if (busy || at + step < 0 || at + step >= ids.length) return
    next.splice(at, 1); next.splice(at + step, 0, id)
    void save(next)
  }
  return <>
    <nav aria-label={t('Folders')} data-testid="sidebar-folders">
      <LoadingContent pending={!folders} skeleton={<Loading layout="folders" testId="folders-loading" />}>
      <Reorder.Group as="div" ref={group} axis="y" values={ids} className="workspace-folder-list" data-testid="folder-reorder-list"
        onReorder={next => { latest.current = next; setOrder(next) }}>
        {ids.map((id, i) => {
          const s = folders!.find(f => f.id === id)!
          return <FolderItem key={s.id} folder={s} collapsed={collapsed} current={route === `/folder/${s.id}`} go={go}
            constraints={group} reorderable={!busy && ids.length > 1} onDragStart={() => { dragging.current = true }} onDragEnd={() => void save(latest.current)}
            moveUp={!busy && i > 0 ? () => move(id, -1) : undefined} moveDown={!busy && i < ids.length - 1 ? () => move(id, 1) : undefined}
            onAppearance={() => setAppearance(s)} onRename={() => setNaming({ folder: s })} onDelete={() => setDeleting(s)} />
        })}
      </Reorder.Group></LoadingContent>
      <button data-testid="folder-create" data-sidebar="menu-button" aria-label={t('New folder')} title={collapsed ? t('New folder') : undefined} className="workspace-nav workspace-folder-new" onClick={() => setNaming({})}>
        <Plus size={16} strokeWidth={1.7} aria-hidden="true" /><span>{t('New folder')}</span>
      </button>
    </nav>
    {appearance && <FolderAppearanceDialog folder={appearance} onDone={() => setAppearance(undefined)} />}
    {naming && <FolderName folder={naming.folder} onDone={(made) => { setNaming(undefined); if (made) go(`/folder/${made.id}`) }} />}
    {deleting && <DeleteFolder folder={deleting} onDone={(gone) => {
      setDeleting(undefined)
      if (gone && route === `/folder/${deleting.id}`) go('')
    }} />}
  </>
}

function FolderItem({ folder, collapsed, current, go, onRename, onDelete, onAppearance, constraints, reorderable, onDragStart, onDragEnd, moveUp, moveDown }: {
  folder: Folder; collapsed: boolean; current: boolean; go: (route: string) => void; onAppearance: () => void; onRename: () => void; onDelete: () => void
  constraints: RefObject<HTMLDivElement | null>; reorderable: boolean; onDragStart: () => void; onDragEnd: () => void; moveUp?: () => void; moveDown?: () => void
}) {
  const controls = useDragControls()
  const reduced = useReducedMotion()
  const dragged = useRef(false)
  const [moving, setMoving] = useState(false)
  const [drop, setDrop] = useState(false)
  const [menu, setMenu] = useState<{ style: CSSProperties; pointer: boolean }>()
  const row = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const open = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: MouseEvent) => { if (!row.current?.contains(e.target as Node)) setMenu(undefined) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])
  // fixed under the row, so the sidebar's scrolling never cuts it off
  const openMenu = (pointer: boolean) => {
    const box = row.current!.getBoundingClientRect()
    const rtl = getComputedStyle(row.current!).direction === 'rtl'
    setMenu({ pointer, style: { position: 'fixed', top: box.bottom + 4, width: Math.max(180, box.width), insetInlineStart: rtl ? window.innerWidth - box.right : box.left } })
  }
  const key = (e: KeyboardEvent) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(undefined); (collapsed ? open : more).current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Tab') setMenu(undefined)
  }
  const run = (fn: () => void) => { setMenu(undefined); (collapsed ? open : more).current?.focus(); fn() }
  const carries = (e: DragEvent) => e.dataTransfer.types.includes(MEETING_DRAG)
  return <Reorder.Item as="div" ref={row} value={folder.id} className="workspace-folder-item" data-testid="sidebar-folder" data-folder={folder.id} data-moving={moving}
    dragListener={false} dragControls={controls} dragConstraints={constraints} dragElastic={0} dragMomentum={false}
    transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 42 }}
    onDragStart={() => { dragged.current = true; setMoving(true); setMenu(undefined); onDragStart() }}
    onDragEnd={() => { setMoving(false); onDragEnd() }}>
    <button ref={open} className="workspace-nav" data-sidebar="menu-button" aria-label={folder.name} title={collapsed ? folder.name : undefined} data-testid="sidebar-folder-open" data-drop={drop} aria-current={current ? 'page' : undefined}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onPointerDown={e => { dragged.current = false; if (reorderable && e.button === 0) controls.start(e, { distanceThreshold: 4 }) }}
      onClick={e => { if (dragged.current && e.detail) { dragged.current = false; return } go(`/folder/${folder.id}`) }}
      onContextMenu={e => { e.preventDefault(); openMenu(true) }}
      onKeyDown={e => { if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); openMenu(false) } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); (e.key === 'ArrowUp' ? moveUp : moveDown)?.() } }}
      onDragEnter={(e) => { if (carries(e)) { e.preventDefault(); setDrop(true) } }}
      onDragOver={(e) => { if (carries(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'link' } }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false)
        const id = e.dataTransfer.getData(MEETING_DRAG)
        if (id) { e.preventDefault(); void window.yogurt.folders.add(folder.id, id) }
      }}>
      <FolderGlyph appearance={folder} /><span>{folder.name}</span>
      <small data-testid="sidebar-folder-count" aria-label={t('{count} meetings', { count: folder.count })}>{folder.count}</small>
    </button>
    <button ref={more} data-testid="sidebar-folder-more" className="workspace-icon workspace-folder-more" aria-haspopup="menu" aria-expanded={!!menu}
      aria-label={t('More for “{name}”', { name: folder.name })} title={t('More')} onClick={(e) => (menu ? setMenu(undefined) : openMenu(e.detail > 0))}>
      <Ellipsis size={15} aria-hidden="true" />
    </button>
    {menu && <div ref={list} data-testid="sidebar-folder-menu" role="menu" aria-label={folder.name} data-pointer={menu.pointer} data-anchor="start" onKeyDown={key} style={menu.style}
      className="menu-entry z-[70] rounded-xl border border-line bg-float p-1.5 shadow-[var(--shadow)]">
      <button role="menuitem" data-testid="sidebar-folder-appearance" onClick={() => run(onAppearance)} className="flex w-full items-center gap-2.5 text-start">
        <Palette size={15} aria-hidden="true" className="text-muted" />{t('Change icon')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-rename" onClick={() => run(onRename)} className="flex w-full items-center gap-2.5 text-start">
        <Pencil size={15} aria-hidden="true" className="text-muted" />{t('Rename')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-up" disabled={!moveUp} onClick={() => moveUp && run(moveUp)} className="flex w-full items-center gap-2.5 text-start">
        <ArrowUp size={15} aria-hidden="true" className="text-muted" />{t('Move up')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-down" disabled={!moveDown} onClick={() => moveDown && run(moveDown)} className="flex w-full items-center gap-2.5 text-start">
        <ArrowDown size={15} aria-hidden="true" className="text-muted" />{t('Move down')}
      </button>
      <button role="menuitem" data-testid="sidebar-folder-delete" onClick={() => run(onDelete)} className="flex w-full items-center gap-2.5 text-start text-danger">
        <Trash2 size={15} aria-hidden="true" />{t('Delete folder')}
      </button>
    </div>}
  </Reorder.Item>
}
