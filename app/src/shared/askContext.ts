export type ContextChip = { kind: 'meeting' | 'folder'; id: string }
export type ContextTarget = ContextChip & { title: string; startedAt?: number }
/** Sent scope is retained; only new draft attachments are appended, in selection order. */
export function attachContext<T extends ContextChip>(scope: T[], draft: T[]): T[] {
  const seen = new Set<string>()
  return [...scope, ...draft].filter(c => {
    const key = `${c.kind}:${c.id}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}
export function contextKey(chips: ContextChip[]): string { return JSON.stringify(chips.map(c => `${c.kind}:${c.id}`).sort()) }
export function chipScope(chips: ContextChip[], meeting: (id: string) => boolean, folder: (id: string) => string[]): string[] | undefined {
  if (!chips.length) return undefined
  return [...new Set(chips.flatMap(c => c.kind === 'meeting' ? meeting(c.id) ? [c.id] : [] : folder(c.id).filter(meeting)))]
}
export function askDestination(route: string): { panel: boolean; fresh: boolean; chips: ContextChip[] } {
  if (route.startsWith('/note/')) return { panel: true, fresh: false, chips: [{ kind: 'meeting', id: route.slice(6) }] }
  if (route.startsWith('/folder/')) return { panel: false, fresh: false, chips: [{ kind: 'folder', id: route.slice(8) }] }
  return { panel: false, fresh: route === '/chat' || route.startsWith('/chat/'), chips: [] }
}

export function mentionAt(value: string, caret: number): { start: number; end: number; query: string } | undefined {
  const match = /(?:^|\s)@([^@\n]{0,80})$/.exec(value.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : undefined
}
