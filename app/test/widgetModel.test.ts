import { describe, expect, it } from 'vitest'
import { WidgetModel, formatElapsed } from '../src/main/widgetModel'

const m = { id: 'm1', title: 'Design review', startedAt: 1000 }

describe('elapsed time', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65_900)).toBe('1:05')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
  })
})

describe('recording hints on Windows and Linux', () => {
  const hint = (os: string, ...codes: ('no-mic' | 'no-system-audio')[]) => {
    const w = new WidgetModel(os)
    w.start(m)
    for (const c of codes) w.warn(c)
    return w.view(2000)?.note
  }
  it('a Mac keeps its words', () => {
    expect(hint('darwin', 'no-mic')?.text).toBe("Yogurt can't hear your mic. Allow it in System Settings.")
    expect(new WidgetModel().view(0)).toBeNull()
  })
  it("Windows points to its own microphone setting, Linux to the sound settings, and neither speaks of System Settings", () => {
    expect(hint('win32', 'no-mic')).toMatchObject({ code: 'no-mic', text: "Yogurt can't hear your mic. Turn on microphone access for desktop apps in Windows Settings." })
    expect(hint('linux', 'no-mic')).toMatchObject({ code: 'no-mic', text: "Yogurt can't hear your mic. Check your sound settings." })
    for (const os of ['win32', 'linux']) {
      expect(hint(os, 'no-system-audio')).toMatchObject({ code: 'no-system-audio', text: "Yogurt can't hear the call audio on this computer." })
      expect(hint(os, 'no-mic', 'no-system-audio')?.text).not.toMatch(/System Settings/)
      expect(hint(os, 'no-mic', 'no-system-audio')?.missingAudio).toEqual(['mic', 'systemAudio'])
    }
  })
})

describe('widget model', () => {
  it('is hidden until a meeting starts', () => {
    expect(new WidgetModel().view(0)).toBeNull()
  })
  it('counts time since the start', () => {
    const w = new WidgetModel()
    w.start(m)
    expect(w.view(6000)).toMatchObject({ kind: 'recording', elapsedMs: 5000, at: 6000 })
    expect(w.view(36_000)).toMatchObject({ elapsedMs: 35_000 })
  })
  it('holds captured time through pauses, resumes without a jump, and can finish while paused', () => {
    const w = new WidgetModel()
    w.start(m)
    w.pause(true, 6000)
    w.pause(true, 8000)
    expect(w.view(9000)).toMatchObject({ kind: 'recording', paused: true, elapsedMs: 5000 })
    w.pause(false, 10000)
    expect(w.view(12000)).toMatchObject({ kind: 'recording', elapsedMs: 7000 })
    expect(w.view(12000)?.paused).toBeUndefined()
    w.pause(true, 15000)
    w.stop(20000)
    expect(w.view(22000)).toMatchObject({ kind: 'captured', elapsedMs: 10000 })
    expect(w.view(22000)?.paused).toBeUndefined()
  })
  it('hints stay until the call is over; device changes say nothing', () => {
    const w = new WidgetModel()
    w.start(m)
    w.warn('device-changed')
    expect(w.view(2000)?.note).toBeNull()
    w.warn('no-system-audio')
    expect(w.view(2000)?.note).toMatchObject({ tone: 'hint', text: "Yogurt can't hear the call audio. Allow it in System Settings." })
    w.warn('no-mic')
    expect(w.view(2000)?.note?.text).toContain("can't hear your microphone or the call")
  })
  it('a hiccup shows for 4 s then the earlier hint comes back', () => {
    const w = new WidgetModel()
    w.start(m)
    w.warn('no-system-audio')
    w.hiccup(10_000)
    expect(w.view(12_000)?.note).toMatchObject({ tone: 'hiccup', text: 'Recording hiccup. Still going.' })
    expect(w.view(14_001)?.note?.tone).toBe('hint')
  })
  it.each([['no-mic', 'no-system-audio'], ['no-system-audio', 'no-mic']] as const)('keeps both unavailable inputs regardless of warning order: %s then %s', (first, second) => {
    const w = new WidgetModel()
    w.start(m); w.warn(first); w.warn(second)
    expect(w.view(2000)?.note).toMatchObject({ code: 'no-mic', missingAudio: ['mic', 'systemAudio'], text: "Yogurt can't hear your microphone or the call. Turn on microphone and call audio in System Settings." })
    w.start(m)
    expect(w.view(2000)?.note).toBeNull()
  })
  it('stop shows the captured card, with the crash message when the helper gave up', () => {
    const w = new WidgetModel()
    w.start(m)
    w.stop(5000)
    expect(w.view(6000)).toMatchObject({ kind: 'captured', crashed: false, elapsedMs: 4000 })
    const x = new WidgetModel()
    x.start(m); x.gaveUp(); x.stop(5000)
    expect(x.view(6000)).toMatchObject({ kind: 'captured', crashed: true })
    x.hide()
    expect(x.view(7000)).toBeNull()
  })
  it('a stopped meeting with unsaved metadata asks for action until saving succeeds', () => {
    const w = new WidgetModel()
    w.start(m); w.stop(5000); w.stopSavePending(true)
    expect(w.view(10000)).toMatchObject({ kind: 'captured', note: { text: 'Recording stopped. Open Yogurt to finish saving.' } })
    w.stopSavePending(false)
    expect(w.view(10000)?.note).toBeNull()
    w.start(m)
    expect(w.view(10000)?.note).toBeNull()
  })
})

describe('transcription hints', () => {
  const hintAt = (w: WidgetModel) => w.view(2000)!.note?.text
  it('shows each in plain words, after the recorder hints, and start clears them', () => {
    const w = new WidgetModel()
    w.start(m)
    w.warn('transcribe-failed')
    expect(hintAt(w)).toBe("Some of this meeting couldn't be transcribed.")
    w.warn('no-speech-model')
    expect(hintAt(w)).toBe("The speech model isn't ready yet, so only audio is being saved.")
    w.warn('falling-behind')
    expect(hintAt(w)).toBe('Yogurt is falling behind. Some lines may be missing.')
    expect(w.view(2000)!.note?.tone).toBe('hint')
    w.warn('no-mic')
    expect(w.view(2000)!.note?.code).toBe('no-mic')
    w.start(m)
    expect(hintAt(w)).toBeUndefined()
  })
})

describe('renaming the meeting while it records', () => {
  it('the widget shows the new title', () => {
    const w = new WidgetModel()
    w.start({ id: 'm', title: 'Zoom call', startedAt: 0 })
    expect(w.retitle('Zoom call')).toBe(false)
    expect(w.retitle('Budget review')).toBe(true)
    expect(w.view(10)!.title).toBe('Budget review')
  })
})

describe('stopped because the call ended', () => {
  it('says so on the finished card', () => {
    const w = new WidgetModel()
    w.start(m)
    w.callEnded()
    w.stop(5000)
    expect(w.view(5000)).toMatchObject({ kind: 'captured', callEnded: true })
  })
  it('a stop by hand does not, and the next meeting starts fresh', () => {
    const w = new WidgetModel()
    w.start(m); w.stop(5000)
    expect(w.view(5000)?.callEnded).toBeUndefined()
    w.callEnded(); w.start(m); w.stop(6000)
    expect(w.view(6000)?.callEnded).toBeUndefined()
  })
})
