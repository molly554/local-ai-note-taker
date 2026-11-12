import type { TranscribeWarn, WarnCode } from './capture'
import type { WidgetView } from '../shared/types'
import { t } from '../shared/i18n'
export { formatElapsed } from '../shared/wave'

const HICCUP_MS = 4000

/** What the recording widget shows, as plain state with time passed in so it can be tested */
export class WidgetModel {
  /** os: the computer, for the words of a missing mic or call audio (a Mac's System Settings, Windows' own setting) */
  constructor(private os: string = 'darwin') {}
  private get mac() { return this.os === 'darwin' }
  /** Windows blocks desktop apps from the mic in its Privacy settings; Linux has no such switch, so its sound settings */
  private noMic(): string {
    return this.os === 'win32' ? t("Yogurt can't hear your mic. Turn on microphone access for desktop apps in Windows Settings.") : t("Yogurt can't hear your mic. Check your sound settings.")
  }
  private m: { id: string; title: string; startedAt: number } | null = null
  private kind: 'recording' | 'captured' = 'recording'
  private endedAt = 0
  private missingAudio = new Set<'mic' | 'systemAudio'>()
  /** transcription trouble; the recorder's hints come first */
  private textHint: TranscribeWarn | null = null
  private hiccupUntil = 0
  private crashed = false
  private savePending = false
  private pausedAt: number | null = null
  private pausedMs = 0
  /** the recording stopped by itself because the call ended */
  private byCall = false

  start(m: { id: string; title: string; startedAt: number }) {
    this.m = m; this.kind = 'recording'
    this.missingAudio.clear(); this.textHint = null; this.hiccupUntil = 0; this.crashed = false; this.savePending = false
    this.pausedAt = null; this.pausedMs = 0; this.byCall = false
  }
  get meetingId(): string | null { return this.m?.id ?? null }
  /** a new title for the meeting shown; true when it changed */
  retitle(title: string): boolean { if (!this.m || this.m.title === title) return false; this.m = { ...this.m, title }; return true }
  warn(code: WarnCode | TranscribeWarn) {
    if (code === 'no-system-audio' || code === 'no-mic') this.missingAudio.add(code === 'no-mic' ? 'mic' : 'systemAudio')
    else if (code === 'transcribe-failed' || code === 'no-speech-model' || code === 'falling-behind') this.textHint = code
  }
  /** the helper was restarted: it records again */
  hiccup(now: number) { this.hiccupUntil = now + HICCUP_MS }
  gaveUp() { this.crashed = true }
  stopSavePending(pending: boolean) { this.savePending = pending }
  pause(paused: boolean, now: number) {
    if (this.kind !== 'recording' || !this.m) return
    if (paused && this.pausedAt === null) this.pausedAt = now
    else if (!paused && this.pausedAt !== null) { this.pausedMs += Math.max(0, now - this.pausedAt); this.pausedAt = null }
  }
  stop(now: number) {
    if (!this.m) return
    this.pause(false, now)
    this.endedAt = now; this.kind = 'captured'
  }
  /** said just before the stop it causes, so the finished card can say why */
  callEnded() { if (this.m && this.kind === 'recording') this.byCall = true }
  hide() { this.m = null }

  view(now: number): WidgetView | null {
    const m = this.m
    if (!m) return null
    const end = this.pausedAt ?? (this.kind === 'captured' ? this.endedAt : now)
    let note: WidgetView['note'] = null
    if (this.kind === 'recording') {
      if (now < this.hiccupUntil) note = { tone: 'hiccup', text: this.pausedAt !== null ? t('Recording hiccup. Still paused.') : t('Recording hiccup. Still going.') }
      else if (this.missingAudio.size === 2) note = { tone: 'hint', code: 'no-mic', missingAudio: ['mic', 'systemAudio'], text: this.mac ? t("Yogurt can't hear your microphone or the call. Turn on microphone and call audio in System Settings.") : this.noMic() }
      else if (this.missingAudio.has('mic')) note = { tone: 'hint', code: 'no-mic', text: this.mac ? t("Yogurt can't hear your mic. Allow it in System Settings.") : this.noMic() }
      else if (this.missingAudio.has('systemAudio')) note = { tone: 'hint', code: 'no-system-audio', text: this.mac ? t("Yogurt can't hear the call audio. Allow it in System Settings.") : t("Yogurt can't hear the call audio on this computer.") }
      else if (this.textHint === 'transcribe-failed') note = { tone: 'hint', text: t("Some of this meeting couldn't be transcribed.") }
      else if (this.textHint === 'no-speech-model') note = { tone: 'hint', text: t("The speech model isn't ready yet, so only audio is being saved.") }
      else if (this.textHint === 'falling-behind') note = { tone: 'hint', text: t('Yogurt is falling behind. Some lines may be missing.') }
    }
    else if (this.savePending) note = { tone: 'hint', text: t('Recording stopped. Open Yogurt to finish saving.') }
    return {
      kind: this.kind, meetingId: m.id, title: m.title,
      elapsedMs: Math.max(0, end - m.startedAt - this.pausedMs), at: now, note, crashed: this.crashed,
      ...(this.pausedAt !== null ? { paused: true } : {}),
      ...(this.byCall && this.kind === 'captured' ? { callEnded: true as const } : {}),
    }
  }
}
