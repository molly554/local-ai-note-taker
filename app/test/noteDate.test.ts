import { afterEach, expect, it, vi } from 'vitest'
import { noteDateLabel } from '../src/renderer/src/dates'
afterEach(() => vi.useRealTimers())
it('uses relative dates today/yesterday and a weekday with the date otherwise', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 8, 12))
  expect(noteDateLabel(+new Date(2026, 10, 8, 9))).toBe('Today')
  expect(noteDateLabel(+new Date(2026, 10, 7, 9))).toBe('Yesterday')
  expect(noteDateLabel(+new Date(2026, 10, 6, 9))).toBe('Fri, Nov 6')
  expect(noteDateLabel(+new Date(2025, 10, 6, 9))).toContain('2025')
})
