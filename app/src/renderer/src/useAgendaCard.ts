import { arrow, autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useLayoutEffect, type RefObject } from 'react'
import { agendaCardGap, agendaCardInset, agendaCardSide, agendaCardSpace, type AgendaCardSide } from '../../shared/agendaCard'
import { surfaceMotion, useReducedMotion } from './motion'

/** Only a side change animates. Ordinary scrolling stays attached to the row. */
export function useAgendaCard(panel: RefObject<HTMLDialogElement | null>, opener: HTMLButtonElement | null, onClose: (restoreFocus?: boolean) => void) {
  const reduced = useReducedMotion()
  useLayoutEffect(() => {
    const el = panel.current, row = opener?.closest<HTMLElement>('.agenda-event')
    const list = row?.closest<HTMLElement>('.agenda-scroll'), column = row?.closest<HTMLElement>('.native-agenda')
    if (!el || !row || !list || !column) return
    const keyboard = opener?.matches(':focus-visible') ?? false
    el.show()
    const cleanup = positionAgendaCard(el, row, list, column, onClose, reduced, keyboard)
    return () => { cleanup(); el.close() }
  }, [panel, opener, onClose, reduced])
}

/** Calendar card positioning and dismissal. */
export function positionAgendaCard(el: HTMLElement, row: HTMLElement, list: HTMLElement, column: HTMLElement, onClose: (restoreFocus?: boolean) => void, reduced: boolean, keyboard = false) {
  const tip = el.querySelector<HTMLElement>('.agenda-inspector-arrow')!
  const content = el.querySelector<HTMLElement>('.agenda-inspector-content')!
  let side: AgendaCardSide | undefined, animation: Animation | undefined
  let lastRowTop = row.getBoundingClientRect().top, serial = 0, disposed = false
  const update = async () => {
    const mine = ++serial, rowRect = row.getBoundingClientRect(), bounds = column.getBoundingClientRect()
    const space = agendaCardSpace(bounds, list.getBoundingClientRect(), rowRect, { width: innerWidth, height: innerHeight })
    if (!row.isConnected || !space.visible) { el.style.visibility = 'hidden'; onClose(false); return }
    const next = agendaCardSide(space, side)
    el.style.width = `${space.width}px`
    const people = content.querySelector<HTMLElement>('.agenda-inspector-scroll')
    const style = getComputedStyle(content)
    const fixedHeight = Array.from(content.children).filter(child => child !== people).reduce((height, child) => {
      const css = getComputedStyle(child)
      return height + child.getBoundingClientRect().height + parseFloat(css.marginTop) + parseFloat(css.marginBottom)
    }, parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + (content.children.length - 1) * parseFloat(style.rowGap) + 2)
    // Keep a usable attendee viewport when pinned details need more than one side offers.
    const minimum = fixedHeight + (people ? Math.min(80, people.scrollHeight) : 0)
    const height = Math.max(0, Math.min(bounds.height - 2 * agendaCardInset, Math.max(space[next], minimum)))
    el.style.maxHeight = `${height}px`
    content.style.maxHeight = `${Math.max(0, height - 2)}px`
    const collision = { boundary: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, padding: agendaCardInset }
    const position = await computePosition(row, el, {
      placement: next,
      middleware: [offset(agendaCardGap), flip({
        ...collision, fallbackStrategy: 'initialPlacement',
        // Collision fallback must not undo the 24px side decision while scrolling.
        fallbackPlacements: side && next === side ? [] : [next === 'top' ? 'bottom' : 'top'],
      }), shift({ ...collision, crossAxis: true }), arrow({ element: tip, padding: 18 })],
    })
    if (disposed || mine !== serial) return
    const nextSide = position.placement as AgendaCardSide
    const oldTop = el.getBoundingClientRect().top + rowRect.top - lastRowTop
    el.style.left = `${position.x}px`
    el.style.top = `${position.y}px`
    const first = el.style.visibility !== 'visible'
    el.style.visibility = 'visible'
    el.dataset.side = nextSide
    tip.style.left = `${position.middlewareData.arrow?.x ?? 18}px`
    if (first) content.querySelector<HTMLElement>(keyboard ? 'button' : 'h3')?.focus({ preventScroll: true })
    if (side && side !== nextSide) {
      // Retarget from the current visual position when a quick reversal interrupts a flip.
      animation?.cancel()
      const distance = oldTop - el.getBoundingClientRect().top
      if (!reduced) animation = el.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], {
        duration: surfaceMotion.settleMs, easing: surfaceMotion.settleEase,
      })
    }
    side = nextSide
    lastRowTop = rowRect.top
  }
  const cleanup = autoUpdate(row, el, () => { void update() }, { animationFrame: true })
  return () => { disposed = true; serial++; cleanup(); animation?.cancel() }
}
