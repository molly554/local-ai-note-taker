import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autonym, isNotesLanguage, spokenOf, whisperLanguage } from '../src/shared/spoken'
import { loadSettings, notesLanguageSetting, spokenSetting, updateSettings } from '../src/main/settings'

describe('the spoken language setting', () => {
  it('is what was picked, and English only when what is saved is not one of the choices', () => {
    expect(spokenOf('en')).toBe('en')
    expect(spokenOf('multi')).toBe('multi')
    expect(spokenOf('zh')).toBe('zh')
    expect(spokenOf('klingon')).toBe('en')
    expect(spokenOf(undefined)).toBe('en')
    expect(spokenSetting({})).toBe('en')
    expect(spokenSetting({ spoken: 'multi' })).toBe('multi')
  })
  it("with nothing picked it is the computer's own language when that can be picked, else English only", () => {
    expect(spokenOf(undefined, 'zh-CN')).toBe('zh')
    expect(spokenOf(undefined, 'zh_TW')).toBe('zh')
    expect(spokenOf(undefined, 'pt-BR')).toBe('pt')
    expect(spokenOf(undefined, 'ja')).toBe('ja')
    expect(spokenOf(undefined, 'en-GB')).toBe('en')
    // Thai is one of the app's languages but not one that can be picked outright
    expect(spokenOf(undefined, 'th')).toBe('en')
    expect(spokenSetting({}, 'ko')).toBe('ko')
    // a choice made is kept whatever the computer speaks
    expect(spokenSetting({ spoken: 'en' }, 'ko')).toBe('en')
    expect(spokenSetting({ spoken: 'multi' }, 'zh-CN')).toBe('multi')
  })
  it('what is picked is written down, English only too: nothing written means "follow the computer"', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yogurt-spoken-')), 'settings.json')
    updateSettings(file, { spoken: 'en' })
    expect(loadSettings(file).spoken).toBe('en')
    expect(spokenSetting(loadSettings(file), 'zh-CN')).toBe('en')
    updateSettings(file, { spoken: 'zh' })
    expect(loadSettings(file).spoken).toBe('zh')
  })
  it('whisper is told the language picked, and left to detect for Multi-language', () => {
    expect(whisperLanguage('en')).toBe('en')
    expect(whisperLanguage('zh')).toBe('zh')
    expect(whisperLanguage('pt')).toBe('pt')
    expect(whisperLanguage('multi')).toBeUndefined()
  })
  it('a language is shown in its own name', () => {
    expect(autonym('zh')).toBe('中文')
    expect(autonym('ja')).toBe('日本語')
    expect(autonym('ko')).toBe('한국어')
    expect(autonym('es')).toBe('Español')
    expect(autonym('ru')).toBe('Русский')
  })
})

describe('the notes language setting', () => {
  it("is each meeting's own unless one of the languages was picked", () => {
    expect(notesLanguageSetting({})).toBeNull()
    expect(notesLanguageSetting({ notesLanguage: 'zh' })).toBe('zh')
    expect(notesLanguageSetting({ notesLanguage: 'en' })).toBe('en')
    expect(notesLanguageSetting({ notesLanguage: 'klingon' as never })).toBeNull()
    // Multi-language is a way of listening, not a language to write in
    expect(isNotesLanguage('multi')).toBe(false)
  })
})
