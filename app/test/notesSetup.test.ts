import { afterEach, describe, expect, it } from 'vitest'
import { notesDownloadText, notesPercent, notesReadyNotice } from '../src/renderer/src/notesSetup'
import { setLanguage } from '../src/shared/i18n'
import type { SetupState } from '../src/shared/types'

const downloading: SetupState = { phase: 'ready', fraction: 1, notesDownloading: true, notesFraction: 0.42 }
const ready: SetupState = { phase: 'ready', fraction: 1 }
afterEach(() => setLanguage('en'))

describe('first notes model progress', () => {
  it('clamps and floors progress without rounding up before the download finishes', () => {
    expect([-0.1, 0, 0.429, 0.999, 1, 2].map(notesPercent)).toEqual(['0%', '0%', '42%', '99%', '100%', '100%'])
  })
  it('announces once after a noticeable download, never again on ready updates', () => {
    const notice = notesReadyNotice()
    expect(notice(downloading, true, 0)).toBe(false)
    expect(notice(downloading, true, 1100)).toBe(false)
    expect(notice(ready, true, 1200)).toBe(true)
    expect(notice(ready, true, 1300)).toBe(false)
    expect(notice(downloading, true, 1400)).toBe(false)
    expect(notice(ready, true, 3000)).toBe(false)
  })
  it('skips cached launches, brief downloads, and downloads only seen while hidden', () => {
    expect(notesReadyNotice()(ready, true, 5000)).toBe(false)
    const brief = notesReadyNotice()
    brief(downloading, true, 0)
    expect(brief(ready, true, 999)).toBe(false)
    const hidden = notesReadyNotice()
    hidden(downloading, false, 0)
    expect(hidden(ready, false, 5000)).toBe(false)
    expect(hidden(ready, true, 6000)).toBe(false)
  })
  it('does not mistake a failed download for readiness; a retry can finish it', () => {
    const notice = notesReadyNotice()
    notice(downloading, true, 0)
    expect(notice({ ...ready, notesError: 'Offline' }, true, 2000)).toBe(false)
    expect(notice(downloading, true, 3000)).toBe(false)
    expect(notice(ready, true, 4000)).toBe(true)
  })
  it('does not count hidden time toward a briefly visible download', () => {
    const notice = notesReadyNotice()
    notice(downloading, true, 0)
    notice(downloading, false, 100)
    expect(notice(ready, false, 5000)).toBe(false)
  })
})


describe('footer download details', () => {
  const progress = { ...downloading, notesTotalBytes: 5e9, notesEtaSec: 240 }
  it('uses the model size and measured ETA, with a shorter native hover title', () => {
    expect(notesDownloadText(progress)).toEqual({
      title: "Downloading Yogurt's AI: 2.1 of 5.0 GB",
      detail: '2.1 of 5.0 GB · about 4 min left',
    })
  })
  it.each([undefined, 0, -1, NaN, Infinity])('does not invent a missing or invalid ETA (%s)', seconds => {
    expect(notesDownloadText({ ...progress, notesEtaSec: seconds }).detail).toBe('2.1 of 5.0 GB')
  })
  it('shows at least a minute, then no ETA while the finished file is being verified', () => {
    expect(notesDownloadText({ ...progress, notesEtaSec: 10 }).detail).toBe('2.1 of 5.0 GB · about 1 min left')
    expect(notesDownloadText({ ...progress, notesFraction: 1 }).detail).toBe('5.0 of 5.0 GB')
  })
  it.each([undefined, 0, -1, NaN, Infinity])('never fabricates a model size (%s)', bytes => {
    expect(notesDownloadText({ ...progress, notesTotalBytes: bytes })).toEqual({ title: "Downloading Yogurt's AI", detail: "Downloading Yogurt's AI" })
  })
  it('bounds downloaded GB and falls back when the fraction is missing', () => {
    expect(notesDownloadText({ ...progress, notesFraction: 2 }).detail).toBe('5.0 of 5.0 GB')
    expect(notesDownloadText({ ...progress, notesFraction: -1, notesEtaSec: undefined }).detail).toBe('0.0 of 5.0 GB')
    expect(notesDownloadText({ ...progress, notesFraction: undefined }).detail).toBe("Downloading Yogurt's AI")
  })
  it('localizes the amounts and the whole detail line', () => {
    setLanguage('fr')
    expect(notesDownloadText(progress)).toEqual({ title: 'Téléchargement de l’IA de Yogurt : 2,1 sur 5,0 Go', detail: '2,1 sur 5,0 Go · reste environ 4 min' })
  })
})
