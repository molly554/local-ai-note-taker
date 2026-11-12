import { expect, test } from 'vitest'
import { softPairAlpha } from '../src/shared/softPair'

test('Soft pair separates, merges and closes its loop without leaving its small canvas', () => {
  expect(softPairAlpha(9, 10, 0)).toBe(0)
  expect(softPairAlpha(9, 10, .5)).toBe(255)
  expect(softPairAlpha(4.3, 10, 0)).toBe(255)
  for (let p = 0; p <= 1; p += .05) {
    for (let x = 0; x <= 18; x++) {
      expect(softPairAlpha(x, 0, p)).toBe(0)
      expect(softPairAlpha(x, 20, p)).toBe(0)
    }
  }
  expect(softPairAlpha(7, 10, 1)).toBeCloseTo(softPairAlpha(7, 10, 0))
})
