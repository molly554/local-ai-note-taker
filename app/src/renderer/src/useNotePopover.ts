import { useLayoutEffect, type RefObject } from 'react'

/** The two metadata popovers share bounds, outside dismissal and immediate keyboard focus. */
export function useNotePopover(card: RefObject<HTMLDivElement | null>, chip: RefObject<HTMLButtonElement | null>, onClose: (restore?: boolean) => void) {
  useLayoutEffect(() => {
    const el = card.current, anchor = chip.current
    if (!el || !anchor) return
    const note = anchor.closest('[data-testid="note"]')
    const measure = () => {
      const rect = anchor.parentElement!.getBoundingClientRect(), width = el.getBoundingClientRect().width
      const rtl = getComputedStyle(el).direction === 'rtl'
      const left = Math.max(12, Math.min(rtl ? rect.right - width : rect.left, innerWidth - width - 12))
      el.style.insetInlineStart = `${rtl ? rect.right - left - width : left - rect.left}px`
      const bottom = Math.min(innerHeight, note?.getBoundingClientRect().bottom ?? innerHeight)
      el.style.setProperty('--people-available-height', `${Math.max(0, bottom - rect.bottom - 16)}px`)
    }
    measure()
    el.querySelector<HTMLElement>('input, button, [tabindex="-1"]')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    if (note) observer.observe(note)
    const away = (e: PointerEvent) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false) }
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    document.addEventListener('pointerdown', away)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); document.removeEventListener('pointerdown', away) }
  }, [card, chip, onClose])
}
