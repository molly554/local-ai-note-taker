/**
 * The language people speak in meetings, picked in the note's footer or Settings → Language. English only tells whisper
 * and Apple's speech it is English, so nothing is guessed, and one of the other languages tells them that one;
 * Multi-language leaves whisper to hear which it is. With nothing picked it is the computer's own language when that
 * can be picked, else English only.
 * Not the interface's language, and not the one the notes are written in (NOTES_LANGUAGES, below).
 */
/** the languages that can be picked outright besides English, as whisper's codes */
export const SPOKEN_LANGUAGES = ['zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru'] as const
export type Spoken = 'en' | 'multi' | (typeof SPOKEN_LANGUAGES)[number]
export const SPOKEN: readonly Spoken[] = ['en', 'multi', ...SPOKEN_LANGUAGES]
export const isSpoken = (v: unknown): v is Spoken => SPOKEN.includes(v as Spoken)
/** with nothing picked: the computer's language ("zh-CN", "pt-BR") when it is one of these, else English only */
export const defaultSpoken = (system = ''): Spoken => {
  const code = system.toLowerCase().split(/[-_]/)[0]
  return code !== 'multi' && isSpoken(code) ? code : 'en'
}
export const spokenOf = (v: unknown, system = ''): Spoken => (isSpoken(v) ? v : defaultSpoken(system))
/** what whisper is told for each chunk: the language, or nothing (it detects, then keeps each track's language) */
export const whisperLanguage = (s: Spoken): string | undefined => (s === 'multi' ? undefined : s)
/** how many languages whisper can hear (whisper.cpp's g_lang list less Cantonese, which large-v3 added) */
export const WHISPER_LANGUAGES = 99

/** a language's own name for itself, for a picker: "中文", "日本語", "Español" */
export const autonym = (code: string): string => {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch { return code }
}

/** The language notes are written in: one of these, or the meeting's own when none is picked */
export const NOTES_LANGUAGES = ['en', ...SPOKEN_LANGUAGES] as const
export type NotesLanguage = (typeof NOTES_LANGUAGES)[number]
export const isNotesLanguage = (v: unknown): v is NotesLanguage => NOTES_LANGUAGES.includes(v as NotesLanguage)
