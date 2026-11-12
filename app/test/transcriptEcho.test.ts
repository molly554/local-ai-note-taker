import { afterEach, expect, it } from 'vitest'
import { echoRuns, echoedLinesLabel, withLive } from '../src/shared/transcript'
import { setLanguage } from '../src/shared/i18n'
const line = (startMs: number, hidden = false, track: 'me' | 'them' = 'me') => ({ startMs, endMs: startMs + 100, track, hidden, speaker: null, text: 'Speech' })
afterEach(() => setLanguage('en'))

it('keeps consecutive echoes together without crossing real speech or changing chronological order', () => {
  const lines = [line(0, false, 'them'), line(100, true), line(200, true), line(300), line(400, true)]
  const runs = echoRuns(lines)
  expect(runs.map(r => [r.echo, r.lines.map(l => l.startMs)])).toEqual([[false, [0]], [true, [100, 200]], [false, [300]], [true, [400]]])
  expect(runs.flatMap(r => r.lines)).toEqual(lines)
  expect(echoRuns([])).toEqual([])
  expect(echoRuns([line(0), line(100)]).some(r => r.echo)).toBe(false)
})

it('appends live echoes to their run, and restoration splits it at the restored speech', () => {
  const lines = [line(0, true), line(100, true)]
  expect(echoRuns([...lines, line(200, true)])[0].lines).toHaveLength(3)
  expect(echoRuns([lines[0], line(100), line(200, true)]).map(r => r.echo)).toEqual([true, false, true])
  expect(echoRuns([line(0), line(100)]).some(r => r.echo)).toBe(false)
})

it('does not group across an intervening live partial, even before it becomes a final line', () => {
  const timeline = withLive([line(0, true), line(200, true)], [{ track: 'them', startMs: 100, endMs: 150, text: 'Hi', words: [{ text: 'Hi', startMs: 100, endMs: 150 }] }])
  expect(echoRuns(timeline).map(r => r.echo)).toEqual([true, false, true])
})

it('labels one echoed line and plural echoed lines', () => {
  expect(echoedLinesLabel(1)).toBe('1 echoed line')
  expect(echoedLinesLabel(2)).toBe('2 echoed lines')
  setLanguage('ru')
  expect(echoedLinesLabel(2)).toBe('2 строки с эхом')
  expect(echoedLinesLabel(5)).toBe('5 строк с эхом')
})

it('silently omits confident echoes but leaves uncertain lines reviewable and restored lines visible', () => {
  const confident = { ...line(100, true), echoConfident: true }
  const uncertain = line(200, true)
  expect(echoRuns([line(0), confident, uncertain]).flatMap(r => r.lines)).toEqual([line(0), uncertain])
  expect(echoRuns([confident])).toEqual([])
  expect(echoRuns([{ ...confident, hidden: false }])[0].echo).toBe(false)
})
