import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WidgetIntent, widgetContains, type WidgetLayout } from '../../../shared/widgetMorph'

/** The same surface and details travel between the two shapes. */
export function useWidgetMorph(card: React.RefObject<HTMLDivElement | null>, warning: boolean, time: string) {
  const intent = useRef(new WidgetIntent()).current
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<WidgetLayout | null>(null)
  const pointer = useRef({ x: -1, y: -1 })
  const animations = useRef<Animation[]>([])
  const resumeAt = useRef<number | null>(null)
  const morph = useRef((immediate = false) => { void immediate })
  /** the frame loop sleeps while nothing can change; anything that might change wakes it */
  const wake = useRef(() => {})
  const freeze = () => {
    for (const a of animations.current) {
      if (card.current?.isConnected) a.commitStyles()
      a.cancel()
    }
    animations.current = []
  }
  useEffect(() => {
    let alive = true
    const off = window.yogurt.widget.onLayout(setLayout)
    void window.yogurt.widget.layout().then(v => { if (alive) setLayout(v) })
    const offPointer = window.yogurt.widget.onPointer(p => { pointer.current = p; wake.current() })
    const offReset = window.yogurt.widget.onReset(() => {
      intent.open = false; intent.over = false; intent.pressed = false; intent.due = null
      resumeAt.current = null; setOpen(false); morph.current(true); wake.current()
    })
    return () => { alive = false; off(); offPointer(); offReset(); freeze() }
  }, [])
  useLayoutEffect(() => {
    const was = intent.warning
    intent.warning = warning
    if (was && !warning && !intent.over) intent.leave(performance.now())
    wake.current()
  }, [warning])
  const previous = useRef<WidgetLayout | null>(null)
  useLayoutEffect(() => {
    const el = card.current
    if (!el || !layout) return
    const items = [...el.querySelectorAll<HTMLElement>('.widget-details > *')]
    const body = el.querySelector<HTMLElement>('.widget-preview')!
    const timerWidth = items[2].getBoundingClientRect().width
    const height = Math.min(warning ? 446 : 390, layout.open.height)
    const up = layout.pill.y + layout.pill.height > layout.open.y + layout.open.height / 2
    const expanded = { ...layout.open, height, y: layout.open.y + (up ? layout.open.height - height : 0) }
    morph.current = (immediate = false) => {
      freeze()
      const opened = intent.open, box = opened ? expanded : layout.pill
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const duration = opened ? 350 : 250, easing = opened ? 'cubic-bezier(.34,1.25,.64,1)' : 'cubic-bezier(.22,1,.36,1)'
      const animate = (node: HTMLElement, to: Record<string, string>, ms = duration, ease = easing, delay = 0) => {
        const computed = getComputedStyle(node), from = Object.fromEntries(Object.keys(to).map(k => [k, computed[k as keyof CSSStyleDeclaration]]))
        Object.assign(node.style, to)
        if (!immediate && !reduced) animations.current.push(node.animate([from, to] as Keyframe[], { duration: ms, easing: ease, delay, fill: 'both' }))
      }
      animate(el, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: opened ? '16px' : '10px' })
      const positions = opened ? [[16, 17], [box.width - timerWidth - 55, 18], [box.width - timerWidth - 16, 18.5]] : [[12, 11], [42, 12], [81, 12.5]]
      items.forEach((item, i) => animate(item, { transform: `translate(${positions[i][0]}px,${positions[i][1]}px)` }))
      body.style.width = `${expanded.width - 2}px`; body.style.height = `${expanded.height - 54}px`
      animate(body, { transform: opened ? 'translateX(0) scale(1)' : 'translateX(40px) scale(.97)', filter: opened ? 'blur(0px)' : 'blur(2px)' }, duration, 'cubic-bezier(.22,1,.36,1)')
      animate(body, { opacity: opened ? '1' : '0' }, opened ? 200 : 120, 'ease-out', opened ? 50 : 0)
      el.style.visibility = 'visible'
    }
    const before = previous.current
    if (before && (intent.pressed || (resumeAt.current !== null && performance.now() < resumeAt.current))) {
      freeze()
      el.style.left = `${parseFloat(el.style.left) + layout.pill.x - before.pill.x}px`
      el.style.top = `${parseFloat(el.style.top) + layout.pill.y - before.pill.y}px`
      el.style.width = `${Math.min(parseFloat(el.style.width), layout.open.width)}px`
      el.style.height = `${Math.min(parseFloat(el.style.height), layout.open.height)}px`
    } else morph.current(true)
    previous.current = layout
    wake.current()
  }, [layout, warning])
  useLayoutEffect(() => {
    if (intent.pressed) return
    const timer = card.current?.querySelector<HTMLElement>('[data-testid="widget-time"]')
    if (timer) window.yogurt.widget.size(95 + timer.getBoundingClientRect().width, 42)
  }, [time, open, layout?.pill.width])
  useEffect(() => {
    let frame = 0, lastPoint = { x: -1, y: -1 }, lastSurface = ''
    const tick = (now: number) => {
      frame = 0
      const el = card.current
      if (el && el.style.visibility === 'visible') {
        const r = el.getBoundingClientRect(), surface = { x: r.x, y: r.y, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(el).borderRadius) }
        const p = pointer.current, inside = widgetContains(surface, p.x, p.y)
        if (inside !== intent.over) inside ? intent.enter(now) : intent.leave(now)
        else if (inside && (p.x !== lastPoint.x || p.y !== lastPoint.y)) intent.move(now)
        lastPoint = p
        const next = intent.tick(now)
        if (next !== null) { setOpen(next); morph.current(); resumeAt.current = null }
        else if (!intent.pressed && resumeAt.current !== null && now >= resumeAt.current) { resumeAt.current = null; morph.current() }
        const key = JSON.stringify(surface)
        if (key !== lastSurface) { lastSurface = key; window.yogurt.widget.surface(surface) }
      }
      // Keep running only while a hover deadline is pending or the shape is moving.
      if (intent.due || resumeAt.current !== null || animations.current.some(a => a.playState === 'running')) frame = requestAnimationFrame(tick)
    }
    wake.current = () => { if (!frame) frame = requestAnimationFrame(tick) }
    wake.current()
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const swap = () => { morph.current(true); wake.current() }
    reduced.addEventListener('change', swap)
    return () => { wake.current = () => {}; cancelAnimationFrame(frame); reduced.removeEventListener('change', swap) }
  }, [])
  return {
    open,
    pointer: (x: number, y: number) => {
      pointer.current = { x, y }
      wake.current()
      const el = card.current
      if (!el || el.style.visibility !== 'visible') return
      const r = el.getBoundingClientRect()
      window.yogurt.widget.surface({ x: r.x, y: r.y, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(el).borderRadius) })
    },
    press: () => { freeze(); intent.press(); resumeAt.current = null; window.yogurt.widget.pressed(true); wake.current() },
    release: (dragged: boolean) => {
      if (!intent.pressed) return
      intent.release(performance.now(), dragged)
      resumeAt.current = performance.now() + (dragged ? 650 : 0)
      wake.current()
      window.yogurt.widget.pressed(false)
      const timer = card.current?.querySelector<HTMLElement>('[data-testid="widget-time"]')
      if (timer) window.yogurt.widget.size(95 + timer.getBoundingClientRect().width, 42)
    },
  }
}
