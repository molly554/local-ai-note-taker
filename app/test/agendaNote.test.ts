import { describe, expect, it } from 'vitest'
import { agendaNoteAction, unusedPreparedNote, DAY_MS } from '../src/shared/agendaNote'
import { openStore } from '../src/main/store'
import type { AgendaEvent } from '../src/shared/types'
const event: AgendaEvent = { id: 'event', title: 'Review', start: 100, end: 200, attendees: [{ name: 'Other', email: null }], url: null }
it('offers one note action and leaves solo blocks alone', () => {
  expect(agendaNoteAction(event, undefined, 50)).toBe('prepare')
  expect(agendaNoteAction(event, undefined, 150)).toBe('start')
  expect(agendaNoteAction({ ...event, note: { id: 'note', state: 'done' } }, undefined, 150)).toBe('open')
  expect(agendaNoteAction({ ...event, note: { id: 'note', state: 'prepared' } }, undefined, 150)).toBe('start')
  expect(agendaNoteAction({ ...event, attendees: [] }, undefined, 150)).toBeNull()
  expect(agendaNoteAction({ ...event, attendees: [], url: 'https://meet.google.com/abc' }, undefined, 50)).toBe('prepare')
})
describe('unused prepared notes', () => {
  const empty = { state: 'prepared', eventEnd: 0, openedAt: 0, mine: '', enhanced: null, segments: 0, userEdited: false }
  it('requires both the event and last opening to be more than a day ago', () => {
    expect(unusedPreparedNote(empty, DAY_MS + 1)).toBe(true)
    for (const patch of [{ eventEnd: 1 }, { openedAt: 1 }, { eventEnd: null }, { openedAt: null }, { mine: ' ' }, { enhanced: 'text' }, { segments: 1 }, { userEdited: true }, { state: 'done' }]) {
      expect(unusedPreparedNote({ ...empty, ...patch }, DAY_MS + 1)).toBe(false)
    }
  })
  it('sweeps only eligible records and keeps protected notes', () => {
    const store = openStore(':memory:')
    try {
      const create = () => { const m = store.createMeeting({ title: 'Review', titleSource: 'calendar', startedAt: 0, endedAt: null, eventId: 'event', app: null, attendees: [], state: 'prepared' }); store.markPrepared(m.id, 0); store.db.prepare('UPDATE meetings SET last_opened_at = 0 WHERE id = ?').run(m.id); return m.id }
      const emptyId = create(), written = create(), recorded = create(), protectedId = create()
      store.setNotes(written, { mine: 'Keep' })
      store.addSegments([{ meetingId: recorded, track: 'me', startMs: 0, endMs: 100, text: 'Keep', speaker: null, hidden: true }])
      expect(store.tidyPrepared(DAY_MS + 1, id => id === protectedId)).toBe(1)
      expect(store.meeting(emptyId)).toBeUndefined()
      for (const id of [written, recorded, protectedId]) expect(store.meeting(id)).toBeDefined()
    } finally { store.close() }
  })
})
