import type { ContextChip } from './askContext'

/** Home is a new question; returning to an unsent draft must not replace it. */
export async function askHomeConversation(api: {
  current: (chips: ContextChip[], fresh?: boolean) => Promise<string>
  get: (id: string) => Promise<{ turns: unknown[] } | null>
}): Promise<string> {
  const id = await api.current([])
  const chat = await api.get(id)
  if (!chat) throw new Error('Conversation not found')
  return chat.turns.length ? api.current([], true) : id
}

export function recentHistory<T extends { title: string; draft: string; updatedAt: number }>(list: T[], limit = 30, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7)
  const visible = list.filter(c => c.title || c.draft)
  const groups: T[][] = [[], [], []]
  for (const c of visible.slice(0, limit)) groups[c.updatedAt >= +today ? 0 : c.updatedAt >= +week ? 1 : 2].push(c)
  return { groups, hasMore: visible.length > limit }
}
