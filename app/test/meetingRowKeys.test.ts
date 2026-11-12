import { expect, it, vi } from 'vitest'
import { deleteMeetingFromKey } from '../src/renderer/src/meetingRowKeys'

const key = (key = 'Delete') => ({ key, repeat: false, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn() })

it('moves a focused, non-recording row to Trash once and consumes Delete', () => {
  const event = key(), trash = vi.fn()
  deleteMeetingFromKey(event, true, false, trash)
  expect(trash).toHaveBeenCalledOnce()
  expect(event.preventDefault).toHaveBeenCalledOnce()
})

it('leaves Backspace, other keys, modifiers and held Delete alone', () => {
  for (const event of [key('Backspace'), key('Enter'), ...['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat', 'defaultPrevented'].map(flag => ({ ...key(), [flag]: true }))]) {
    const trash = vi.fn()
    deleteMeetingFromKey(event, true, false, trash)
    expect(trash).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
})

it('never deletes a recording or handles a key from a menu or input', () => {
  for (const [focused, recording] of [[true, true], [false, false]]) {
    const event = key(), trash = vi.fn()
    deleteMeetingFromKey(event, focused, recording, trash)
    expect(trash).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
})
