import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as logo from '../src/shared/logo'
import { MARK } from '../src/shared/logo'

const svg = (name: string) => readFileSync(join(import.meta.dirname, '../build', name), 'utf8')
const paths = (text: string) => [...text.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])

// The app draws the mark from shared/logo.ts; the icons are rendered from build/*.svg. One script writes them all
// from the same numbers, and they must stay one drawing.
describe('logo', () => {
  it('is the sheet of notes whose first line is a voice: one outline with five bars and two lines cut out of it', () => {
    expect(MARK.match(/M/g)).toHaveLength(8)
    expect(createHash('sha256').update(MARK).digest('hex')).toBe('b650784543d1f994c005a8f5f8a69f8b986b703754b8f6f97283b93751ec9f9f')
  })
  it("carries nothing of upstream's logo: no second drawing for a wordmark", () => {
    expect(Object.keys(logo)).toEqual(['MARK'])
  })
  it('matches build/logo.svg', () => {
    expect(paths(svg('logo.svg'))).toEqual([MARK])
  })
  it("build/icon.svg has the same five bars and two lines on the violet-to-blue square, with the Mac's room around it", () => {
    const icon = svg('icon.svg')
    expect(icon).toContain('stop-color="#AE7BFF"')
    expect(icon).toContain('stop-color="#5785FA"')
    expect(icon.match(/<rect x=/g)).toHaveLength(7)
    // 100 of 1024 left on every side, as upstream's icon had
    expect(icon).toContain('viewBox="0 0 256 256"')
    expect(icon).toContain('transform="translate(25 25) scale(0.805)"')
  })
  it('build/wordmark.svg is the icon with the name beside it, as text', () => {
    const wordmark = svg('wordmark.svg')
    expect(wordmark).toContain('>Lynote <tspan')
    expect(wordmark).toContain('NoteTaker</tspan>')
  })
})
