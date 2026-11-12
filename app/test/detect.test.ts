import { describe, expect, it } from 'vitest'
import { callAppId, tabTitleApp, CALL_GONE_MS, callGone, decide, ended, isOwnMicApp, useCallApps, type Signals } from '../src/main/detect'
import type { CalEvent } from '../src/main/calendar'

const NOW = Date.parse('2026-10-29T15:00:00Z')
const MIN = 60_000
const ev = (o: Partial<CalEvent> = {}): CalEvent => ({ id: 'e1', title: 'Design review', start: NOW, end: NOW + 30 * MIN, attendees: [], url: null, ...o })
const sig = (o: Partial<Signals> = {}): Signals => ({ micApps: [], events: [], recording: false, ...o })
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
const chrome = { bundleId: 'com.google.Chrome', name: 'Google Chrome' }
const none = new Set<string>()

describe('decide', () => {
  it('zoom using the mic with a matching event: a prompt with the event', () => {
    const e = ev({ start: NOW - 2 * MIN })
    const p = decide(sig({ micApps: [zoom], events: [e] }), NOW, none)
    expect(p).toMatchObject({ title: 'Design review', app: 'Zoom', event: e })
    expect(p?.key).toBeTruthy()
  })
  it('zoom with no event: a prompt with no event, named Zoom', () => {
    expect(decide(sig({ micApps: [zoom] }), NOW, none)).toMatchObject({ app: 'Zoom', event: null, title: '' })
  })
  it('Zoom CptHost is the same call app and dismissal key as Zoom', () => {
    const helper = sig({ micApps: [{ bundleId: 'us.zoom.CptHost', name: 'CptHost' }], runningApps: ['us.zoom.xos'] })
    expect(decide(helper, NOW, none)).toMatchObject({ app: 'Zoom', key: 'app:us.zoom.xos' })
    expect(decide(helper, NOW, new Set(['app:us.zoom.xos']))).toBeNull()
  })
  it('a helper process of a known app counts as the app', () => {
    expect(decide(sig({ micApps: [{ bundleId: 'us.zoom.xos.helper', name: 'x' }], runningApps: ['us.zoom.xos'] }), NOW, none)?.app).toBe('Zoom')
  })
  it('an app that is not a meeting app: nothing', () => {
    expect(decide(sig({ micApps: [{ bundleId: 'com.apple.VoiceMemos', name: 'Voice Memos' }] }), NOW, none)).toBeNull()
  })
  it('chrome using the mic with no meeting event: null', () => {
    expect(decide(sig({ micApps: [chrome], events: [ev()] }), NOW, none)).toBeNull()
    expect(decide(sig({ micApps: [chrome] }), NOW, none)).toBeNull()
  })
  it('chrome with an event that has a meeting link: a prompt', () => {
    const e = ev({ url: 'https://meet.google.com/abc-defg-hij' })
    expect(decide(sig({ micApps: [chrome], events: [e] }), NOW, none)).toMatchObject({ app: 'Chrome', event: e })
  })
  it('chrome whose window is a web call: a prompt even with no event', () => {
    const m = { ...chrome, title: 'Meet - abc-defg-hij' }
    expect(decide(sig({ micApps: [m] }), NOW, none)).toMatchObject({ app: 'Chrome', event: null })
  })
  it('an event starting now with no mic in use: no prompt', () => {
    expect(decide(sig({ events: [ev({ url: 'https://zoom.us/j/1' })] }), NOW, none)).toBeNull()
  })
  it('while recording: null', () => {
    expect(decide(sig({ micApps: [zoom], events: [ev()], recording: true }), NOW, none)).toBeNull()
  })
  it('a dismissed key stays quiet', () => {
    const s = sig({ micApps: [zoom], events: [ev()] })
    const p = decide(s, NOW, none)!
    expect(decide(s, NOW + MIN, new Set([p.key]))).toBeNull()
  })
  it('a dismissed call app with no event stays quiet too', () => {
    const p = decide(sig({ micApps: [zoom] }), NOW, none)!
    expect(decide(sig({ micApps: [zoom] }), NOW + MIN, new Set([p.key]))).toBeNull()
  })
  it('two overlapping events: the one with a link', () => {
    const plain = ev({ id: 'a', title: 'Plain', start: NOW - MIN })
    const linked = ev({ id: 'b', title: 'Linked', start: NOW + 5 * MIN, url: 'https://zoom.us/j/2' })
    expect(decide(sig({ micApps: [zoom], events: [plain, linked] }), NOW, none)?.event?.id).toBe('b')
  })
  it('ignores events that start more than 10 minutes away or already ended', () => {
    const far = ev({ id: 'far', start: NOW + 11 * MIN, end: NOW + 40 * MIN })
    const over = ev({ id: 'over', start: NOW - 20 * MIN, end: NOW - MIN })
    expect(decide(sig({ micApps: [zoom], events: [far, over] }), NOW, none)?.event).toBeNull()
  })
})

describe('ended', () => {
  it('true after 30 s without the mic, false at 29 s', () => {
    expect(ended(sig(), 30_000)).toBe(true)
    expect(ended(sig(), 29_000)).toBe(false)
  })
  it('the event over by 5 minutes with 60 s of silence on both tracks', () => {
    const event = ev()
    const ctx = (silentMs: number, now: number) => ({ event, silentMs, now })
    expect(ended(sig(), 0, ctx(60_000, event.end + 5 * MIN))).toBe(true)
    expect(ended(sig(), 0, ctx(59_000, event.end + 5 * MIN))).toBe(false)
    expect(ended(sig(), 0, ctx(60_000, event.end + 4 * MIN))).toBe(false)
  })
  it('no event, no silence reading: only the mic counts', () => {
    expect(ended(sig(), 0, { event: null, silentMs: 600_000, now: NOW })).toBe(false)
  })
})

describe('real bundle ids', () => {
  const p = (bundleId: string, extra: object = {}) => decide(sig({ micApps: [{ bundleId, name: 'x', ...extra }], runningApps: [callAppId(bundleId)!] }), NOW, none)?.app
  it.each([
    ['us.zoom.xos', 'Zoom'], ['us.zoom.xos.helper', 'Zoom'],
    ['com.microsoft.teams', 'Teams'], ['com.microsoft.teams2', 'Teams'], ['com.microsoft.teams2.helper', 'Teams'],
    ['com.cisco.webexmeetingsapp', 'Webex'], ['Cisco-Systems.Spark', 'Webex'], ['com.apple.FaceTime', 'FaceTime'],
    ['com.tinyspeck.slackmacgap', 'Slack'], ['com.hnc.Discord', 'Discord'],
    ['net.whatsapp.WhatsApp', 'WhatsApp'], ['WhatsApp', 'WhatsApp'],
  ])('%s is %s', (id, name) => expect(p(id)).toBe(name))
  it.each([
    ['com.google.Chrome', 'Chrome'], ['company.thebrowser.Browser', 'Arc'], ['com.microsoft.edgemac', 'Edge'],
    ['org.mozilla.firefox', 'Firefox'], ['com.brave.Browser', 'Brave'],
    ['com.apple.Safari', 'Safari'], ['com.apple.WebKit.WebContent', 'Safari'], ['com.apple.WebKit.GPU', 'Safari'],
  ])('browser %s is %s once the tab is a call', (id, name) => expect(p(id, { title: 'Zoom Meeting' })).toBe(name))
  it('safari\'s web process without a call sign: nothing', () => expect(p('com.apple.WebKit.WebContent', { title: 'YouTube' })).toBeUndefined())
})

describe('browser tab titles', () => {
  it('chrome on the mic, a Meet tab, no event: a prompt', () => {
    expect(decide(sig({ micApps: [{ ...chrome, title: 'Meet - abc-defg-hij' }] }), NOW, none)).toMatchObject({ app: 'Chrome', event: null })
  })
  it('chrome on the mic, YouTube tab: null', () => {
    expect(decide(sig({ micApps: [{ ...chrome, title: 'YouTube' }] }), NOW, none)).toBeNull()
  })
})

describe('callGone', () => {
  const call = { app: 'Zoom', seen: true, micIdleMs: 0 }
  it('a call app that let go of the mic for the grace has ended; a blip has not', () => {
    expect(CALL_GONE_MS).toBe(10_000)
    expect(callGone({ ...call, micIdleMs: 10_000 })).toBe(true)
    expect(callGone({ ...call, micIdleMs: 9_999 })).toBe(false)
  })
  it('the grace can be shorter (fake mode)', () => {
    expect(callGone({ ...call, micIdleMs: 500, graceMs: 500 })).toBe(true)
  })
  it('never for a recording started by hand with no call', () => {
    expect(callGone({ app: null, seen: true, micIdleMs: 60 * MIN })).toBe(false)
  })
  it('never before the call app was seen on the mic this time (a resumed note after the call)', () => {
    expect(callGone({ ...call, seen: false, micIdleMs: 60 * MIN })).toBe(false)
  })
})


describe('audio helpers need their running owner', () => {
  it.each([
    ['com.apple.avconferenced', 'com.apple.FaceTime', 'FaceTime'],
    ['us.zoom.CptHost', 'us.zoom.xos', 'Zoom'],
    ['us.zoom.xos.helper', 'us.zoom.xos', 'Zoom'],
    ['com.apple.WebKit.GPU', 'com.apple.Safari', 'Safari'],
    ['net.whatsapp.WhatsApp.WAAppKitBridgeService', 'net.whatsapp.WhatsApp', 'WhatsApp'],
    ['WhatsApp-Helper', 'WhatsApp', 'WhatsApp'],
    ['WhatsApp-Helper.renderer', 'WhatsApp', 'WhatsApp'],
    ['org.mozilla.plugincontainer', 'org.mozilla.firefox', 'Firefox'],
  ])('%s belongs to %s only while it is running', (bundleId, owner, name) => {
    const s = sig({ micApps: [{ bundleId, name: 'not used for attribution', title: 'Meet - abc' }] })
    expect(callAppId(bundleId)).toBe(owner)
    expect(decide(s, NOW, none)).toBeNull()
    expect(decide({ ...s, runningApps: ['some.other.app'] }, NOW, none)).toBeNull()
    expect(decide({ ...s, runningApps: [owner] }, NOW, none)).toMatchObject({ app: name, key: `app:${owner}` })
    expect(decide({ ...s, runningApps: [owner] }, NOW, new Set([`app:${owner}`]))).toBeNull()
  })
})


describe('all supported browsers need a call sign', () => {
  it.each(['com.google.Chrome', 'com.apple.Safari', 'com.microsoft.edgemac', 'org.mozilla.firefox', 'company.thebrowser.Browser', 'com.brave.Browser'])('%s never triggers from mic use alone', bundleId => {
    const mic = { bundleId, name: 'Browser' }
    expect(tabTitleApp(bundleId)).toBe(bundleId)
    expect(decide(sig({ micApps: [mic] }), NOW, none)).toBeNull()
    expect(decide(sig({ micApps: [{ ...mic, title: 'Voice recorder' }], events: [ev()] }), NOW, none)).toBeNull()
    for (const title of ['Meet - abc', 'Microsoft Teams', 'Zoom Meeting']) {
      expect(decide(sig({ micApps: [{ ...mic, title }] }), NOW, none)?.key).toBe(`app:${bundleId}`)
    }
    expect(decide(sig({ micApps: [mic], events: [ev({ url: 'https://meet.google.com/abc' })] }), NOW, none)?.key).toBe(`event:e1:${NOW}`)
  })
  it('asks Firefox for a title when its child process holds the mic', () => {
    expect(tabTitleApp('org.mozilla.plugincontainer')).toBe('org.mozilla.firefox')
  })
  it('does not match lookalike helper prefixes', () => {
    for (const id of ['net.whatsapp.WhatsAppOther', 'WhatsApp-HelperOther', 'com.apple.avconferencedOther']) expect(callAppId(id)).toBeNull()
  })
})

describe('call apps on Windows and Linux', () => {
  const on = (platform: string, fn: () => void) => { useCallApps(platform); try { fn() } finally { useCallApps('darwin') } }
  it('Windows names apps by their program: Zoom, the new and classic Teams, Webex, Slack, Discord, WhatsApp', () => on('win32', () => {
    for (const [id, name] of [['zoom.exe', 'Zoom'], ['ms-teams.exe', 'Teams'], ['teams.exe', 'Teams'], ['webex.exe', 'Webex'], ['ciscocollabhost.exe', 'Webex'], ['slack.exe', 'Slack'], ['discord.exe', 'Discord'], ['whatsapp.root.exe', 'WhatsApp']])
      expect(decide(sig({ micApps: [{ bundleId: id, name: id }] }), NOW, none)?.app).toBe(name)
    // the Mac's ids mean nothing there
    expect(decide(sig({ micApps: [zoom] }), NOW, none)).toBeNull()
  }))
  it("Zoom's meeting host on Windows counts while Zoom runs", () => on('win32', () => {
    expect(callAppId('cpthost.exe')).toBe('zoom.exe')
    expect(decide(sig({ micApps: [{ bundleId: 'cpthost.exe', name: 'CptHost' }], runningApps: ['zoom.exe'] }), NOW, none)).toMatchObject({ app: 'Zoom', key: 'app:zoom.exe' })
    expect(decide(sig({ micApps: [{ bundleId: 'cpthost.exe', name: 'CptHost' }] }), NOW, none)).toBeNull()
  }))
  it('a browser on Windows counts with a call in its window title', () => on('win32', () => {
    expect(tabTitleApp('msedge.exe')).toBe('msedge.exe')
    expect(decide(sig({ micApps: [{ bundleId: 'chrome.exe', name: 'Chrome', title: 'Meet - abc-defg-hij - Google Chrome' }] }), NOW, none)?.app).toBe('Chrome')
    expect(decide(sig({ micApps: [{ bundleId: 'chrome.exe', name: 'Chrome', title: 'Inbox - Google Chrome' }] }), NOW, none)).toBeNull()
  }))
  it('Linux knows programs and Flatpak ids', () => on('linux', () => {
    for (const [id, name] of [['zoom', 'Zoom'], ['us.zoom.Zoom', 'Zoom'], ['teams-for-linux', 'Teams'], ['com.slack.Slack', 'Slack'], ['Discord', 'Discord'], ['webex', 'Webex']])
      expect(decide(sig({ micApps: [{ bundleId: id, name: id }] }), NOW, none)?.app).toBe(name)
    expect(decide(sig({ micApps: [{ bundleId: 'org.mozilla.firefox', name: 'Firefox', title: 'Zoom Meeting — Mozilla Firefox' }] }), NOW, none)?.app).toBe('Firefox')
  }))
  it("Yogurt's own recorder on the mic is never a call", () => {
    for (const [p, ids] of [['win32', ['yogurt-audio.exe', 'lynote notetaker.exe']], ['linux', ['yogurt-audio', 'lynote-notetaker', 'lynote-notetaker-bin', 'Lynote NoteTaker']]] as const) on(p, () => {
      for (const id of ids) {
        expect(isOwnMicApp(id)).toBe(true)
        expect(decide(sig({ micApps: [{ bundleId: id, name: id, title: 'Zoom meeting' }] }), NOW, none)).toBeNull()
      }
      expect(isOwnMicApp('zoom.exe')).toBe(false)
    })
    expect(isOwnMicApp('yogurt-audio')).toBe(false)
  })
})
