import { describe, expect, it } from 'vitest'
import { setupItems, transcriptionPhase, transcriptionPercent } from '../src/renderer/src/components/SetupStatus'

describe('transcription download status', () => {
  it('names download and preparation truthfully, with bounded progress', () => {
    expect(transcriptionPhase({ phase: 'downloading', fraction: .09 })).toBe('Downloading the transcription model')
    expect(transcriptionPercent({ phase: 'downloading', fraction: .099 })).toBe('9%')
    expect(transcriptionPhase({ phase: 'downloading', fraction: 1 })).toBe('Preparing the transcription model')
    expect(transcriptionPercent({ phase: 'downloading', fraction: 1.2 })).toBe('100%')
    expect(setupItems({ phase: 'ready', fraction: 1 })[0]).toEqual({ id: 'transcription', done: true, text: 'Transcription ready' })
  })
})
