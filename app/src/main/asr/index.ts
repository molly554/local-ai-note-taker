import { onCaptureStart, recordingFinished, type TranscribeWarn } from '../capture'
import { onMeetingStart, onMeetingStop } from '../meeting'
import { isFake } from '../paths'
import type { Meeting, Segment, Store } from '../store'
import { createPipeline, type Pipeline } from './pipeline'
import { echoConfidence } from './echo'
import { appleSpeechAvailable, installSpeechLocale, readSpeechLocales, speechDisagrees, speechFits, wantedSpeechLocale, type SpeechHost, type SpeechLocales } from './appleSpeech'
import { whisperLanguage, type Spoken } from '../../shared/spoken'
import { createWhisperServer, recoverer, vadModelPath, whisperServerPath, type WhisperServer } from './server'
import { createTranscriber, type Line, type Transcribe } from './transcribe'
import { meetingWords, respell, whisperPrompt } from '../vocab'
import type { TranscriptPartial } from '../../shared/types'
import type { Chunk } from './chunker'

/**
 * Live transcription of the meeting being recorded: the capture's audio goes through a pipeline (chunks, whisper-server,
 * echo check) that saves lines to the store and tells the window. A meeting's session is found by its id, whichever of
 * "meeting started" and "capture started" comes first, so the order the hooks were registered in does not matter.
 */
type Session = { pipeline: Pipeline | null; priorLines: Set<number>; done?: Promise<void>; store?: SessionStore; refresh?: (id: string) => void
  /** Apple's speech listens in this locale for the meeting (null: whisper only); off once whisper hears another language */
  speech?: string | null }

/**
 * The saved transcript comes from whisper; Apple's words are the live view. Languages listed here are the ones where Apple's
 * finals measured as good or better on real meeting audio, and are saved instead, skipping whisper.
 * None yet: the ruling waits for the measurements.
 */
export const APPLE_FINALS_LANGUAGES: ReadonlySet<string> = new Set<string>()

/** seconds of someone talking with no word from Apple's speech before whisper's own readings take over (its first words can take a while to warm up) */
const SPEECH_WATCH_POLLS = 15
/** Apple's speech is set aside for the rest of this meeting: whisper's quick readings come back */
function speechOff(s: Session, why: string) {
  if (!s.speech) return
  console.log(`speech: ${why}: Apple's words are set aside for this meeting`)
  s.speech = null
  s.pipeline?.setQuickReads(true)
}

/** what the Mac's speech can do, read once at start-up (nothing where it is not available) */
let speechLocales: SpeechLocales = { available: false, supported: [], installed: [] }
let speechDeps: { ui: () => string; last: () => string | null; install: (locale: string) => Promise<boolean> } | undefined
/** the spoken language picked (English only or Multi-language), read each time it matters */
let spokenNow: () => Spoken = () => 'en'
const installing = new Set<string>()
/**
 * The locale Apple's speech listens in for a new meeting, or null for whisper only. A wanted locale whose model is not on the
 * Mac yet is fetched now (once, in the background) for the next meeting.
 */
const decided = new Map<string, string | null>()
export function speechLocaleFor(meetingId?: string): string | null {
  // one decision per meeting, whichever of the recorder and the transcription asks first
  if (meetingId && decided.has(meetingId)) return decided.get(meetingId)!
  const out = decide()
  if (meetingId) { decided.set(meetingId, out); if (decided.size > 50) decided.delete(decided.keys().next().value!) }
  return out
}
function decide(): string | null {
  if (!speechDeps || !speechLocales.available) return null
  const wanted = wantedSpeechLocale({ spoken: spokenNow(), supported: speechLocales.supported, last: speechDeps.last(), ui: speechDeps.ui() })
  if (!wanted) return null
  if (speechLocales.installed.includes(wanted)) return wanted
  if (!installing.has(wanted)) {
    installing.add(wanted)
    console.log(`speech: fetching Apple's ${wanted} model for the next meeting`)
    void speechDeps.install(wanted).then((ok) => { if (ok) speechLocales = { ...speechLocales, installed: [...speechLocales.installed, wanted] } }).finally(() => installing.delete(wanted))
  }
  return null
}
/**
 * The spoken language was changed (the note's footer or Settings): whisper hears it from the next chunk on. A recording
 * switched to English only whose Apple speech listens in another language gets whisper's quick readings back instead.
 */
export function spokenChanged() {
  const spoken = spokenNow()
  for (const s of sessions.values()) if (s.speech && !speechFits(spoken, s.speech)) speechOff(s, 'English only was picked')
}
/** segments and hideSegments: the echo sweep after the meeting (tests may leave them out) */
type SessionStore = Pick<Store, 'updateMeeting'> & Partial<Pick<Store, 'segments' | 'hideSegments' | 'meeting'>>

let server: WhisperServer | undefined
let serverKey: string | undefined
const sessions = new Map<string, Session>()
/** how much was heard in each language, per meeting; kept after the transcript is done, for the notes */
const heard = new Map<string, Map<string, number>>()

/** The language most of the meeting was said in (whisper's name for it, e.g. "spanish"); null when not known */
export function meetingLanguage(id: string): string | null {
  let best: string | null = null, most = 0
  for (const [lang, n] of heard.get(id) ?? []) if (n > most) { best = lang; most = n }
  return best
}

/** How long whisper-server stays up after the last meeting's transcript is done: back-to-back meetings skip the load */
export const SERVER_IDLE_MS = 10 * 60_000
let idleTimer: NodeJS.Timeout | undefined
let idleMs = SERVER_IDLE_MS

/** whisper-server left the graphics card during a meeting (Windows and Linux) */
let gpuOffListener: (() => void) | undefined
export function onWhisperGpuOff(cb: () => void) { gpuOffListener = cb }

/** One whisper-server while meetings need it: started (warmed up) when one starts, let go a while after the last */
function serverFor(model: string, pidFile: string | undefined, make?: (model: string, pidFile?: string) => WhisperServer): WhisperServer {
  clearTimeout(idleTimer)
  const key = `${model}|${pidFile}`
  if (!server || serverKey !== key) {
    void server?.stop()
    server = make ? make(model, pidFile) : createWhisperServer({ binary: whisperServerPath(), model, pidFile, vadModel: vadModelPath(), gpuFallback: process.platform !== 'darwin', onGpuOff: () => gpuOffListener?.() })
    serverKey = key
  }
  return server
}

/** no meeting left to transcribe: whisper-server's memory goes back to the Mac after a while */
function armServerIdle() {
  clearTimeout(idleTimer)
  if (sessions.size || !server) return
  idleTimer = setTimeout(() => {
    if (sessions.size || !server) return
    const s = server
    server = undefined; serverKey = undefined
    void s.stop().catch((e) => console.error('stopping whisper-server failed', e))
  }, idleMs)
}

/** The note about "no speech model" waits a moment so the widget, which opens on the same meeting start, is there to show it */
const NO_MODEL_NOTE_DELAY_MS = 400

export function hookTranscription(p: {
  store: Pick<Store, 'addSegments' | 'updateMeeting'> & Partial<Pick<Store, 'segments' | 'hideSegments' | 'meeting'>>
  /** the speech model, once setup has it */
  modelPath: () => string | undefined
  send: (seg: Omit<Segment, 'id'>) => void
  /** saved echoes changed during recording or the final sweep: the window reads them again */
  refresh?: (meetingId: string) => void
  /** a quick reading of what is being said right now; none: no partials */
  sendPartial?: (part: TranscriptPartial) => void
  /** for tests: how long a me line waits for the echo check, and the extra wait while their line is on its way */
  holdMs?: number
  extraWaitMs?: number
  /** trouble to show the person (once per meeting each) */
  warn: (code: TranscribeWarn) => void
  /** where whisper-server keeps its pid, so a later start can clean up after a crash */
  pidFile?: string
  /** for tests; heard(language, chars, locked) says what language a chunk was in */
  transcriber?: ((c: Chunk, heard?: (language: string, chars: number, locked?: boolean) => void, o?: { partial?: boolean }) => Promise<Line[]> | Line[]) | undefined
  onStart?: (fn: (m: Meeting) => void) => unknown
  onStop?: (fn: (m: Meeting) => void) => unknown
  /** for tests: a stand-in whisper-server, and how long it stays up after the last meeting */
  server?: (model: string, pidFile?: string) => WhisperServer
  serverIdleMs?: number
  /** who said a line of the other side, as the call app showed it (callNames); null: Them */
  nameOf?: (meetingId: string, startMs: number, endMs: number) => string | null
  /** Apple's on-device speech for the live words (macOS 26, Apple Silicon): where to ask what it can do, and the locale choices */
  speech?: { host: SpeechHost; binary: string; ui: () => string; last: () => string | null; locales?: () => Promise<SpeechLocales>; install?: (locale: string) => Promise<boolean> }
  /** the spoken language picked in Settings or the note (English only when left out) */
  spoken?: () => Spoken
}): () => void {
  idleMs = p.serverIdleMs ?? SERVER_IDLE_MS
  spokenNow = p.spoken ?? (() => 'en')
  if (p.speech && appleSpeechAvailable(p.speech.host)) {
    const sp = p.speech
    speechDeps = { ui: sp.ui, last: sp.last, install: sp.install ?? ((l) => installSpeechLocale(sp.binary, l)) }
    void (sp.locales ?? (() => readSpeechLocales(sp.binary)))().then((l) => { speechLocales = l; if (l.available) console.log(`speech: Apple's on-device speech can listen in ${l.installed.length} of ${l.supported.length} locales`) })
  } else { speechDeps = undefined; speechLocales = { available: false, supported: [], installed: [] } }
  const open = (id: string): Session => {
    const have = sessions.get(id)
    if (have) return have
    const warned = new Set<TranscribeWarn>()
    const warnOnce = (k: TranscribeWarn) => { if (!warned.has(k)) { warned.add(k); p.warn(k) } }
    let transcribe: Transcribe | undefined
    const langs = new Map<string, number>()
    heard.set(id, langs)
    const hear = (lang: string, chars: number, locked = false) => {
      langs.set(lang, (langs.get(lang) ?? 0) + chars)
      // whisper, sure of the language (locked on it), hears another one than Apple listens in: back to whisper's own quick readings
      if (locked && s.speech && speechDisagrees(s.speech, lang)) speechOff(s, `whisper heard ${lang}, not ${s.speech}`)
    }
    const promptOf = () => { const m = p.store.meeting?.(id); return m ? whisperPrompt(meetingWords(m)) : '' }
    if (p.transcriber) { const f = p.transcriber; transcribe = async (c, o) => f(c, (l, n, locked) => hear(l, n, locked), o) }
    // fake mode's stand-in is loaded only in fake mode, so it stays out of what real runs load
    else if (isFake()) transcribe = async (c, o) => (await import('./fake')).fakeTranscribe(c, o, promptOf(), whisperLanguage(spokenNow()))
    else {
      const model = p.modelPath()
      if (model) {
        const srv = serverFor(model, p.pidFile, p.server)
        srv.resetBudget()
        // the model takes a few seconds to load: start now, so the first chunk does not wait for it
        srv.url().catch((e) => console.error('whisper-server did not start', e))
        transcribe = createTranscriber({ url: () => srv.url(), recover: recoverer(srv), onLanguage: (_t, lang, chars, locked) => hear(lang, chars, locked), prompt: promptOf,
          language: () => whisperLanguage(spokenNow()) })
      } else {
        console.warn('no speech model yet: this meeting is recorded but not transcribed')
        setTimeout(() => warnOnce('no-speech-model'), NO_MODEL_NOTE_DELAY_MS)
      }
    }
    const s: Session = {
      store: p.store, refresh: p.refresh, speech: speechLocaleFor(id), priorLines: new Set(p.store.segments?.(id).map((s) => s.id) ?? []),
      pipeline: transcribe ? createPipeline({ meetingId: id, transcribe, save: (segs) => {
        p.store.addSegments(segs)
        if (segs.some(s => s.hidden)) p.refresh?.(id)
      }, emit: p.send, emitPartial: p.sendPartial, holdMs: p.holdMs, extraWaitMs: p.extraWaitMs, onWarn: warnOnce,
        nameOf: p.nameOf && ((a, b) => p.nameOf!(id, a, b)),
        respell: (t) => { const m = p.store.meeting?.(id); return m ? respell(t, meetingWords(m)) : t } }) : null,
    }
    if (s.speech) s.pipeline?.setQuickReads(false)
    sessions.set(id, s)
    return s
  }

  const offStart = (p.onStart ?? onMeetingStart)((m) => { open(m.id) })
  // each capture of a meeting (a restarted recorder is a new one) feeds that meeting's session
  const offCapture = onCaptureStart((c, meetingId) => {
    const s = open(meetingId)
    c.on('pcm', (track, ms, samples) => s.pipeline?.push(track, ms, samples))
    // Apple's speech that never speaks up: the helper says so, or someone has talked for a while with no word from it
    c.on('speech-off', () => speechOff(s, 'the helper could not run it'))
    // Apple listening on one track only: whisper's own quick readings cover the other
    c.on('speech-ready', (tracks) => { if (!s.speech || !s.pipeline) return; for (const t of ['me', 'them'] as const) if (!tracks.includes(t)) s.pipeline.setQuickReads(true, t) })
    let heardSpeech = false, talkedPolls = 0
    const watch = setInterval(() => {
      if (!s.speech || heardSpeech || !s.pipeline) { clearInterval(watch); return }
      if (s.pipeline.talking('me') || s.pipeline.talking('them')) talkedPolls++
      if (talkedPolls >= SPEECH_WATCH_POLLS) { clearInterval(watch); speechOff(s, 'no words came while people talked') }
    }, 1000)
    c.on('ended', () => clearInterval(watch))
    // Apple's words: the live view (whisper's line replaces them), or the saved line too where Apple measured as good
    c.on('speech', (f) => {
      heardSpeech = true
      if (!s.speech || !s.pipeline) return
      const saves = APPLE_FINALS_LANGUAGES.has(s.speech.split('-')[0])
      if (f.final && saves) s.pipeline.speechLines(f.track, [{ track: f.track, startMs: Math.round(f.startMs), endMs: Math.round(f.endMs), text: f.text }])
      else s.pipeline.speechPartial(f.track, { final: f.final, startMs: Math.round(f.startMs), endMs: Math.round(f.endMs), text: f.text, ...(f.words ? { words: f.words } : {}) })
    })
  })
  const offStop = (p.onStop ?? onMeetingStop)((m) => {
    const s = sessions.get(m.id)
    if (s) finishSession(m.id, s, () => recordingFinished(m.id), p.store)
  })
  return () => {
    for (const off of [offStart, offCapture, offStop]) if (typeof off === 'function') off()
  }
}

/**
 * Every line is in: me lines that are the mic's copy of what the other side said are hidden (kept, out of the transcript,
 * to be shown again). Live, a me line is only checked against their lines that had arrived in time; without headphones
 * some echoes slip through that. Only a meeting where echo was heard in the audio: with headphones every me line is the person's own.
 */
function sweepEcho(id: string, s: Session) {
  const store = s.store
  if (!store?.segments || !store.hideSegments || !s.pipeline?.echoPresent()) return
  try {
    const pipe = s.pipeline
    // A resumed session may overlap the previous final line; its audio cannot reclassify saved words.
    const lines = store.segments(id).filter(line => !s.priorLines.has(line.id)), them = lines.filter(line => line.track === 'them')
    const matches = lines.filter(line => line.track === 'me').map(line => ({ id: line.id, confidence: echoConfidence(line, them, { echo: true, correlatedAt: ms => pipe.echoAt(ms), over: (a, b) => pipe.echoOver(a, b) }) }))
    const gone = matches.filter(line => line.confidence).map(line => line.id)
    if (!gone.length) return
    store.hideSegments(gone, matches.filter(line => line.confidence === 'high').map(line => line.id))
    console.log(`echo: ${gone.length} me line(s) hidden after the meeting`)
    s.refresh?.(id)
  } catch (e) { console.error('hiding echoes failed', e) }
}

/** After the recorder is done (no more audio coming), the pipeline finishes what it has, then echoes are swept */
function finishSession(id: string, s: Session, audioDone: () => Promise<void> = () => Promise.resolve(), store?: SessionStore): Promise<void> {
  s.store ??= store
  s.done ??= audioDone().then(() => s.pipeline?.finish()).then(() => sweepEcho(id, s)).catch((e) => console.error('finishing the transcript failed', e)).finally(() => {
    // the meeting's main language is kept with it, for notes written later (after a restart too)
    const lang = meetingLanguage(id)
    if (lang) { try { s.store?.updateMeeting(id, { language: lang }) } catch (e) { console.error('saving the language failed', e) } }
    heard.delete(id)
    if (sessions.get(id) === s) sessions.delete(id)
    armServerIdle()
  })
  return s.done
}

/** Resolves when the meeting's transcript is all saved (after it stops); at once when there is nothing left to do */
export const transcriptFinished = (id: string): Promise<void> => sessions.get(id)?.done ?? Promise.resolve()

export const transcriptPartials = (): TranscriptPartial[] => [...sessions.values()].flatMap((s) => s.pipeline?.partials() ?? [])

/** The most audio waiting for transcription on any track of any meeting, in ms: model work makes way past 30 s */
export const transcriptionBacklogMs = (): number => Math.max(0, ...[...sessions.values()].map((s) => s.pipeline?.backlogMs() ?? 0))

/** Lines are still being worked on or held */
export const transcribing = (): boolean => sessions.size > 0

/** Quitting: finish the transcript of any meeting (the recorder has been stopped first); after capMs give up */
export async function settleTranscription(capMs = 20_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<void>((r) => { timer = setTimeout(r, capMs) })
  await Promise.race([Promise.all([...sessions].map(([id, s]) => finishSession(id, s))), cap])
  clearTimeout(timer)
}

/** Quitting: whisper-server goes with the app */
export function stopTranscriptionServer() { clearTimeout(idleTimer); server?.kill(); server = undefined; serverKey = undefined }
