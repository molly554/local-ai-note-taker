import { execFile } from 'node:child_process'
import type { Spoken } from '../../shared/spoken'

/**
 * Apple's on-device speech (SpeechAnalyzer and SpeechTranscriber, macOS 26 on Apple Silicon) for the live words: it
 * reads on the Neural Engine and gives volatile text as someone talks. Never SFSpeechRecognizer, which can send audio
 * away. Its model is downloaded once through AssetInventory, like Yogurt's own models; no audio leaves the Mac.
 * Whisper stays everywhere else, and for the saved transcript: on real meetings whisper got 19.5% of words wrong, Apple 25.0%.
 */
export type SpeechHost = { platform: string; arch: string; /** the kernel's version, e.g. 25.4.0 (macOS 26 is Darwin 25) */ osRelease: string }

export const appleSpeechAvailable = (h: SpeechHost): boolean => h.platform === 'darwin' && h.arch === 'arm64' && Number(h.osRelease.split('.')[0]) >= 25

/** whisper's language names → ISO 639-1 codes (what a locale starts with) */
const CODES: Record<string, string> = {
  english: 'en', spanish: 'es', german: 'de', french: 'fr', japanese: 'ja', italian: 'it', portuguese: 'pt', chinese: 'zh', korean: 'ko',
  dutch: 'nl', russian: 'ru', arabic: 'ar', hindi: 'hi', turkish: 'tr', polish: 'pl', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi',
  ukrainian: 'uk', czech: 'cs', greek: 'el', hebrew: 'he', indonesian: 'id', vietnamese: 'vi', thai: 'th', romanian: 'ro', hungarian: 'hu', catalan: 'ca', malay: 'ms',
}
export const languageCode = (whisperName: string | null | undefined): string | null => {
  if (!whisperName) return null
  const n = whisperName.toLowerCase()
  return CODES[n] ?? (/^[a-z]{2}$/.test(n) ? n : null)
}

/** whisper's name for a language code ('en' → 'english'), as its guesses name them */
export const languageName = (code: string): string => Object.keys(CODES).find((n) => CODES[n] === code) ?? code

const lang = (locale: string) => locale.split(/[-_]/)[0].toLowerCase()
const region = (locale: string) => locale.split(/[-_]/)[1]?.toUpperCase()
/** the region to listen in when the interface names none: the biggest one for each language Apple covers */
const HOME: Record<string, string> = { en: 'US', es: 'ES', de: 'DE', fr: 'FR', it: 'IT', pt: 'BR', zh: 'CN', ja: 'JP', ko: 'KR' }

/**
 * The locale to listen in: the meeting's language once whisper heard it, else the last meetings', else the interface's.
 * Its region follows the interface's where that exists, else the language's biggest, else the first on the list. null: Apple has no model for any.
 */
export function pickSpeechLocale(o: { supported: string[]; detected?: string | null; last?: string | null; ui: string }): string | null {
  const list = [...o.supported].sort()
  const uiRegion = region(o.ui)
  const find = (code: string): string | null => {
    const same = list.filter((l) => lang(l) === code)
    if (!same.length) return null
    return (uiRegion && same.find((l) => region(l) === uiRegion)) || same.find((l) => region(l) === HOME[code]) || same[0]
  }
  for (const code of [languageCode(o.detected), languageCode(o.last), lang(o.ui)]) {
    if (!code) continue
    const found = find(code)
    if (found) return found
  }
  return null
}

/**
 * The locale for a new meeting under the spoken language picked: one language listens in it (the interface's region
 * when the interface is in it, else the biggest), or not at all when the Mac has no model for it; Multi-language is pickSpeechLocale.
 */
export function wantedSpeechLocale(o: { spoken: Spoken; supported: string[]; last?: string | null; ui: string }): string | null {
  if (o.spoken === 'multi') return pickSpeechLocale(o)
  return pickSpeechLocale({ supported: o.supported.filter((l) => lang(l) === o.spoken), detected: o.spoken, ui: o.ui })
}

/** Apple may keep listening in this locale under the spoken language picked (a recording switched to one language) */
export const speechFits = (spoken: Spoken, locale: string): boolean => spoken === 'multi' || lang(locale) === spoken

/** whisper heard another language than the one Apple listens in: its words are not to be trusted for this meeting */
export const speechDisagrees = (locale: string, detected: string | null | undefined): boolean => {
  const code = languageCode(detected)
  return !!code && code !== lang(locale)
}

export type SpeechLocales = { available: boolean; supported: string[]; installed: string[] }
/** yogurt-audio speech-locales: what the Mac's speech can do; nothing where it can't (an older macOS, an Intel Mac) */
export function readSpeechLocales(binary: string): Promise<SpeechLocales> {
  return new Promise((resolve) => {
    execFile(binary, ['speech-locales'], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve({ available: false, supported: [], installed: [] })
      try {
        const j = JSON.parse(stdout) as Partial<SpeechLocales>
        const strs = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : [])
        resolve({ available: j.available === true, supported: strs(j.supported), installed: strs(j.installed) })
      } catch { resolve({ available: false, supported: [], installed: [] }) }
    })
  })
}
/** yogurt-audio speech-install LOCALE: Apple's model for that locale, downloaded once (true once it is there) */
export function installSpeechLocale(binary: string, locale: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, ['speech-install', locale], { timeout: 15 * 60_000 }, (err, stdout) => {
      if (err) return resolve(false)
      try { resolve((JSON.parse(stdout) as { installed?: unknown }).installed === true) } catch { resolve(false) }
    })
  })
}
