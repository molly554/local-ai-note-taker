import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spokenOf, whisperLanguage } from '../src/shared/spoken'
import { loadSettings, spokenSetting, updateSettings } from '../src/main/settings'

describe('the spoken language setting', () => {
  it('is English only unless Multi-language was picked', () => {
    expect(spokenOf(undefined)).toBe('en')
    expect(spokenOf('en')).toBe('en')
    expect(spokenOf('multi')).toBe('multi')
    expect(spokenOf('klingon')).toBe('en')
    expect(spokenSetting({})).toBe('en')
    expect(spokenSetting({ spoken: 'multi' })).toBe('multi')
  })
  it('English only is the default, so only Multi-language is written down', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-spoken-')), 'settings.json')
    updateSettings(file, { spoken: 'multi' })
    expect(loadSettings(file).spoken).toBe('multi')
    updateSettings(file, { spoken: undefined })
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('spoken')
  })
  it('whisper is told English for English only, and left to detect for Multi-language', () => {
    expect(whisperLanguage('en')).toBe('en')
    expect(whisperLanguage('multi')).toBeUndefined()
  })
})
