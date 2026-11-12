import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Icons that change in place: every option shares one grid cell, so nothing around it moves, and only the current
 * one shows. The one leaving shrinks, softens and fades while the next grows in (scaled on the wrapper, never the
 * svg, so the icon stays crisp).
 */
export function Swap<K extends string>({ show, options, className }: { show: K; options: Record<K, ReactNode>; className?: string }) {
  return <span className={`swap ${className ?? ''}`} aria-hidden="true">
    {(Object.keys(options) as K[]).map(key => <span key={key} data-on={key === show}>{options[key]}</span>)}
  </span>
}

/** A label that changes in place: the new words soften in, and `widest` holds the width so the label never shifts. */
export function SwapText({ text, widest }: { text: string; widest?: string }) {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true }, [])
  return <span className="swap-text" data-widest={widest}><span key={text} className={mounted.current ? 'swap-in' : undefined}>{text}</span></span>
}
