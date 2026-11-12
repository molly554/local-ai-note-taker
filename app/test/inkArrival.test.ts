import { expect, it } from 'vitest'
import { InkArrival } from '../src/shared/inkArrival'

it('keeps word ages across redraws, growing words and corrected text', () => {
  const ink = new InkArrival()
  expect(ink.update('First wor', 100).map(w => w.born)).toEqual([100, 100])
  expect(ink.update('First word next', 200).map(w => w.born)).toEqual([100, 100, 200])
  expect(ink.update('First word next', 300).map(w => 300 - w.born)).toEqual([200, 200, 100])
  expect(ink.update('First new word next', 400).map(w => w.born)).toEqual([100, 400, 100, 200])
  ink.update('', 500)
  expect(ink.update('First', 600)).toEqual([{ from: 0, to: 5, born: 600 }])
})
