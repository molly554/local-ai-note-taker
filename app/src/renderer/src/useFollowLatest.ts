import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { attachFollowLatest } from './followLatest'

export function useFollowLatest(scroll: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, enabled: boolean, initiallyFollowing = true) {
  const stuck = useRef(initiallyFollowing)
  const controls = useRef<ReturnType<typeof attachFollowLatest> | null>(null)
  const [behind, setBehind] = useState(false)
  useLayoutEffect(() => {
    const el = scroll.current, body = content.current
    if (!enabled || !el || !body) return
    const follow = attachFollowLatest(el, body, stuck, setBehind)
    controls.current = follow
    return () => { follow.dispose(); controls.current = null }
  }, [enabled, scroll, content])
  return {
    behind: enabled && behind,
    resume: () => { stuck.current = true; setBehind(false) },
    latest: () => controls.current?.latest(),
  }
}
