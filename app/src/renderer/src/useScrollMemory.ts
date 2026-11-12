import { useLayoutEffect, useRef } from 'react'

// Reading positions last for this app session, without keeping hidden pages or subscriptions alive.
const positions = new Map<string, number>()
const visible = new Map<string, HTMLElement>()
export const rememberedScroll = (key: string) => positions.get(key)
export function rememberScrollPositions() {
  for (const [key, el] of visible) if (el.clientHeight) positions.set(key, el.scrollTop)
}

export function useScrollMemory<T extends HTMLElement>(key: string, ready = true) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    visible.set(key, el)
    if (ready && positions.has(key)) el.scrollTop = positions.get(key)!
    const save = () => { if (el.clientHeight) positions.set(key, el.scrollTop) }
    el.addEventListener('scroll', save, { passive: true })
    return () => { visible.delete(key); el.removeEventListener('scroll', save) }
  }, [key, ready])
  return ref
}
