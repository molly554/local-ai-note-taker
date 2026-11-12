export type AgendaCardSide = 'top' | 'bottom'
type Rect = { top: number; bottom: number; left: number; right: number }

export const agendaCardInset = 8
export const agendaCardGap = 12
export const agendaCardHysteresis = 24

/** Room is measured in the column, while visibility belongs to the scrolling list. */
export function agendaCardSpace(column: Rect, list: Rect, row: Rect, viewport: { width: number; height: number }) {
  const top = Math.max(0, column.top) + agendaCardInset
  const bottom = Math.min(viewport.height, column.bottom) - agendaCardInset
  const left = Math.max(0, column.left) + agendaCardInset
  const right = Math.min(viewport.width, column.right) - agendaCardInset
  return {
    visible: row.bottom > Math.max(list.top, 0) && row.top < Math.min(list.bottom, viewport.height),
    top: Math.max(0, row.top - top - agendaCardGap),
    bottom: Math.max(0, bottom - row.bottom - agendaCardGap),
    width: Math.max(0, right - left),
  }
}

/** Keep the current side until the alternative has meaningfully more room. */
export function agendaCardSide(space: { top: number; bottom: number }, previous?: AgendaCardSide): AgendaCardSide {
  if (!previous) return space.top > space.bottom ? 'top' : 'bottom'
  const other = previous === 'top' ? 'bottom' : 'top'
  return space[other] > space[previous] + agendaCardHysteresis ? other : previous
}
