import { describe, expect, it } from 'vitest'
import { appleSpeechAvailable, languageCode, pickSpeechLocale, speechDisagrees, speechFits, wantedSpeechLocale } from '../src/main/asr/appleSpeech'

describe("Apple's on-device speech: where it may run", () => {
  it('needs macOS 26 (Darwin 25) on Apple Silicon', () => {
    expect(appleSpeechAvailable({ platform: 'darwin', arch: 'arm64', osRelease: '25.4.0' })).toBe(true)
    expect(appleSpeechAvailable({ platform: 'darwin', arch: 'arm64', osRelease: '26.0.0' })).toBe(true)
    expect(appleSpeechAvailable({ platform: 'darwin', arch: 'arm64', osRelease: '24.6.0' })).toBe(false)
    expect(appleSpeechAvailable({ platform: 'darwin', arch: 'x64', osRelease: '25.4.0' })).toBe(false)
    expect(appleSpeechAvailable({ platform: 'win32', arch: 'arm64', osRelease: '25.4.0' })).toBe(false)
  })
})

describe('which locale it listens in', () => {
  const supported = ['en-US', 'en-GB', 'es-ES', 'es-MX', 'de-DE', 'fr-FR', 'ja-JP']
  it("the meeting's language once whisper heard it, else the last meetings', else the interface's", () => {
    expect(pickSpeechLocale({ supported, detected: 'spanish', last: 'german', ui: 'en-US' })).toBe('es-ES')
    expect(pickSpeechLocale({ supported, detected: null, last: 'german', ui: 'en-US' })).toBe('de-DE')
    expect(pickSpeechLocale({ supported, detected: null, last: null, ui: 'en-GB' })).toBe('en-GB')
  })
  it("a language's region follows the interface where it has one, else the language's biggest", () => {
    expect(pickSpeechLocale({ supported, detected: 'english', last: null, ui: 'en-GB' })).toBe('en-GB')
    expect(pickSpeechLocale({ supported, detected: 'spanish', last: null, ui: 'es-MX' })).toBe('es-MX')
    expect(pickSpeechLocale({ supported, detected: 'spanish', last: null, ui: 'en-US' })).toBe('es-ES')
    expect(pickSpeechLocale({ supported, detected: null, last: null, ui: 'en' })).toBe('en-US')
  })
  it('a language Apple has no model for falls through to the next choice, and to nothing', () => {
    expect(pickSpeechLocale({ supported, detected: 'hindi', last: 'japanese', ui: 'en-US' })).toBe('ja-JP')
    expect(pickSpeechLocale({ supported, detected: 'hindi', last: null, ui: 'hi-IN' })).toBeNull()
    expect(pickSpeechLocale({ supported: [], detected: 'english', last: null, ui: 'en-US' })).toBeNull()
  })
  it("whisper's names become codes; unknown names are left alone", () => {
    expect(languageCode('english')).toBe('en')
    expect(languageCode('Japanese')).toBe('ja')
    expect(languageCode('de')).toBe('de')
    expect(languageCode('klingon')).toBeNull()
    expect(languageCode(null)).toBeNull()
  })
  it('whisper hearing another language than the one listened in means back to whisper', () => {
    expect(speechDisagrees('es-ES', 'english')).toBe(true)
    expect(speechDisagrees('es-ES', 'spanish')).toBe(false)
    expect(speechDisagrees('en-US', null)).toBe(false)
    expect(speechDisagrees('en-US', 'klingon')).toBe(false)
  })
})

describe('the spoken language picked in Yogurt', () => {
  const supported = ['en-US', 'en-GB', 'en-AU', 'es-ES', 'de-DE']
  it('English only listens in English whatever the last meeting was, in the region of the interface when it is English', () => {
    expect(wantedSpeechLocale({ spoken: 'en', supported, last: 'spanish', ui: 'en-GB' })).toBe('en-GB')
    expect(wantedSpeechLocale({ spoken: 'en', supported, last: 'german', ui: 'de-DE' })).toBe('en-US')
    expect(wantedSpeechLocale({ spoken: 'en', supported, last: null, ui: 'es-ES' })).toBe('en-US')
  })
  it('English only with no English model on the Mac: whisper only, never another language', () => {
    expect(wantedSpeechLocale({ spoken: 'en', supported: ['es-ES', 'de-DE'], last: null, ui: 'es-ES' })).toBeNull()
  })
  it("Multi-language keeps today's choice: the last meeting's language, else the interface's", () => {
    expect(wantedSpeechLocale({ spoken: 'multi', supported, last: 'spanish', ui: 'en-GB' })).toBe('es-ES')
    expect(wantedSpeechLocale({ spoken: 'multi', supported, last: null, ui: 'de-DE' })).toBe('de-DE')
  })
  it('a recording switched to English only keeps Apple listening only when it listens in English', () => {
    expect(speechFits('en', 'en-GB')).toBe(true)
    expect(speechFits('en', 'es-ES')).toBe(false)
    expect(speechFits('multi', 'es-ES')).toBe(true)
  })
  it('a language picked outright listens in it, in the interface region when the interface is in it, or not at all when the Mac has no model for it', () => {
    const more = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']
    expect(wantedSpeechLocale({ spoken: 'zh', supported: more, last: 'english', ui: 'en-US' })).toBe('zh-CN')
    expect(wantedSpeechLocale({ spoken: 'zh', supported: more, last: null, ui: 'zh-TW' })).toBe('zh-TW')
    expect(wantedSpeechLocale({ spoken: 'ko', supported: more, last: null, ui: 'en-US' })).toBeNull()
    expect(speechFits('zh', 'zh-CN')).toBe(true)
    expect(speechFits('zh', 'en-US')).toBe(false)
  })
})
