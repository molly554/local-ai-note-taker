import { describe, expect, it } from 'vitest'
import { agendaCardSide, agendaCardSpace } from '../src/shared/agendaCard'

const column = { top: 50, bottom: 750, left: 800, right: 1100 }
const list = { top: 270, bottom: 720, left: 820, right: 1080 }
const viewport = { width: 1100, height: 760 }
const row = (top: number, bottom: number) => ({ top, bottom, left: 820, right: 1080 })

describe('agenda card placement', () => {
  it('opens above a bottom row, below a top row, with 8px insets and 12px row clearance', () => {
    const bottom = agendaCardSpace(column, list, row(650, 710), viewport)
    expect(bottom).toEqual({ visible: true, top: 580, bottom: 20, width: 284 })
    expect(agendaCardSide(bottom)).toBe('top')
    expect(agendaCardSide(agendaCardSpace(column, list, row(280, 330), viewport))).toBe('bottom')
  })
  it('uses the visible window intersection and never produces a negative size', () => {
    expect(agendaCardSpace({ top: -100, bottom: 900, left: -20, right: 1200 }, list, row(280, 330), viewport))
      .toEqual({ visible: true, top: 260, bottom: 410, width: 1084 })
    const space = agendaCardSpace({ top: 300, bottom: 310, left: 900, right: 910 }, list, row(290, 320), viewport)
    expect(space).toMatchObject({ top: 0, bottom: 0, width: 0 })
  })
  it('keeps a partially visible row and dismisses one that leaves either list edge', () => {
    expect(agendaCardSpace(column, list, row(250, 280), viewport).visible).toBe(true)
    expect(agendaCardSpace(column, list, row(710, 740), viewport).visible).toBe(true)
    expect(agendaCardSpace(column, list, row(230, 270), viewport).visible).toBe(false)
    expect(agendaCardSpace(column, list, row(720, 760), viewport).visible).toBe(false)
  })
  it('uses the roomier side immediately on first open, with a stable bottom tie', () => {
    expect(agendaCardSide({ top: 301, bottom: 300 })).toBe('top')
    expect(agendaCardSide({ top: 300, bottom: 301 })).toBe('bottom')
    expect(agendaCardSide({ top: 300, bottom: 300 })).toBe('bottom')
  })
  it('requires more than 24px advantage to flip in either direction', () => {
    expect(agendaCardSide({ top: 300, bottom: 324 }, 'top')).toBe('top')
    expect(agendaCardSide({ top: 300, bottom: 325 }, 'top')).toBe('bottom')
    expect(agendaCardSide({ top: 324, bottom: 300 }, 'bottom')).toBe('bottom')
    expect(agendaCardSide({ top: 325, bottom: 300 }, 'bottom')).toBe('top')
  })
  it('does not flicker when scrolling back and forth near equal space', () => {
    let side = agendaCardSide({ top: 330, bottom: 300 })
    for (const top of [300, 290, 310, 288, 302, 276]) side = agendaCardSide({ top, bottom: 300 }, side)
    expect(side).toBe('top')
    side = agendaCardSide({ top: 275, bottom: 300 }, side)
    expect(side).toBe('bottom')
    for (const top of [290, 310, 324]) side = agendaCardSide({ top, bottom: 300 }, side)
    expect(side).toBe('bottom')
  })
})
