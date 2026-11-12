import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Workspace } from '../src/renderer/src/components/Workspace'

afterEach(() => vi.unstubAllGlobals())

const folders = [{ id: 's1', name: 'Acme & co', createdAt: 1, count: 2, icon: 'folder' as const, color: 'default' as const }]
function heading(route: string, meeting?: { id: string; title: string }) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, addEventListener() {}, removeEventListener() {} })
  const html = renderToStaticMarkup(createElement(Workspace, { route, meeting, folders, go() {}, search() {}, collapsed: false, sidebarMotion: false, toggleSidebar() {}, children: null }))
  return html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? ''
}

it('uses plain page titles and always reserves both history controls', () => {
  for (const route of ['', '/meetings']) expect(heading(route)).toContain('>Meetings</span>')
  for (const [route, label] of [
    ['/chat', 'Ask'], ['/folder/s1', 'Acme &amp; co'], ['/folder/gone', 'Folder'],
    ['/trash', 'Trash'], ['/settings', 'Settings'],
  ]) {
    expect(heading(route)).toContain(`>${label}</span>`)
    expect(heading(route)).toContain('data-testid="nav-back"')
    expect(heading(route)).toContain('data-testid="nav-forward"')
    expect((heading(route).match(/<svg/g) ?? []).length).toBe(2)
    expect(heading(route)).not.toContain('lucide-house')
  }
})

it('a saved chat is still under Ask', () => {
  expect(heading('/chat/abc-1')).toContain('>Ask</span>')
  expect(heading('/chat/abc-1')).not.toContain('lucide-message-circle')
})

it('shows the current meeting title without leaking the previous meeting heading', () => {
  expect(heading('/note/a', { id: 'a', title: 'Launch & review' })).toContain('>Launch &amp; review</span>')
  const next = heading('/note/b', { id: 'a', title: 'Launch & review' })
  expect(next).not.toContain('Launch')
  expect(next).toContain('>Meeting</span>')
})
