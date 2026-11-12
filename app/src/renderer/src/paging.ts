/** what main gives at most per call is capped, so long lists come in steps of this many */
const STEP = 500

type Fetch<C> = (o: { before?: { at: number; id: string }; limit: number }) => Promise<C[]>

/** The newest cards, at least `page` and up to `target`, in steps; more: there may be older ones still */
export async function loadUpTo<C extends { id: string; startedAt: number }>(fetch: Fetch<C>, target: number, page: number): Promise<{ cards: C[]; more: boolean }> {
  const want = Math.max(target, page)
  const cards: C[] = []
  while (cards.length < want) {
    const limit = Math.min(STEP, want - cards.length)
    const last = cards.at(-1)
    const got = await fetch({ limit, ...(last ? { before: { at: last.startedAt, id: last.id } } : {}) })
    cards.push(...got)
    if (got.length < limit) return { cards, more: false }
  }
  return { cards, more: true }
}
