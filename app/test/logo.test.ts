import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MARK, WORD } from '../src/shared/logo'

const svg = (name: string) => readFileSync(join(import.meta.dirname, '../build', name), 'utf8')
const paths = (text: string) => [...text.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])

// The app draws the logo from shared/logo.ts; the icons are rendered from build/*.svg. They must stay one drawing.
describe('logo', () => {
  it('retains the approved organic quotation contours exactly', () => {
    expect(createHash('sha256').update(MARK).digest('hex')).toBe('0fc9bdced4f92d52e61dd66ef66c45034ef3d8d88292a419d8551b5d674cd028')
  })
  it('matches build/logo.svg', () => {
    expect(paths(svg('logo.svg'))).toEqual([MARK])
  })
  it('matches build/wordmark.svg', () => {
    expect(paths(svg('wordmark.svg'))).toEqual([MARK, WORD])
  })
  it('matches the original quotation in build/icon.svg', () => {
    expect(paths(svg('icon.svg')).join('')).toBe(MARK)
  })
  it('fills 58% of the Mac tile and centres the original 100-unit mark canvas', () => {
    const icon = svg('icon.svg')
    const mark = icon.match(/<path[^>]*transform="translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)"/)!
    expect(mark).not.toBeNull()
    const [, x, y, scale] = mark.map(Number)
    expect(90.17375 * scale / 236).toBeCloseTo(.58, 6)
    expect(x + 50 * scale).toBeCloseTo(128, 6)
    expect(y + 50 * scale).toBeCloseTo(128, 6)
  })
})
