import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callAppId, callAppName } from '../src/main/detect'
import { Watcher } from '../src/main/watch'
import type { Reading } from '../src/main/detectSignals'
import type { Meeting } from '../src/main/store'
import type { CalEvent } from '../src/main/calendar'

const MIN = 60_000
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us' }
let clock = 1_000_000_000_000
let reading: Reading
let active: Meeting | null
let log: string[]
let silent = 0
let w: Watcher
let auto = true
const autoWatcher = () => new Watcher({
  read: async () => reading, now: () => clock, active: () => active,
  bindApp: (_id, app) => (active = { ...active!, app }),
  offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'),
  autoStop: (m) => log.push('auto:' + m.id), autoStopOn: () => auto,
})

const ev = (o: Partial<CalEvent> = {}): CalEvent => ({ id: 'e1', title: 'Review', start: clock, end: clock + 30 * MIN, attendees: [], url: null, ...o })
const meeting = (o: Partial<Meeting> = {}): Meeting => ({ id: 'm1', title: 'Review', startedAt: clock, endedAt: null, eventId: null, app: 'Zoom', attendees: [], state: 'recording', language: null, titleSource: 'generic', ...o })

beforeEach(() => {
  clock = 1_000_000_000_000; reading = { micApps: [], events: [] }; active = null; log = []; silent = 0
  w = new Watcher({
    read: async () => reading, now: () => clock, active: () => active,
    bindApp: (_id, app) => (active = { ...active!, app }),
    offer: (p) => log.push('offer:' + p.key), askStop: () => log.push('stop'), hide: () => log.push('hide'),
    silentMs: () => silent,
  })
})

describe('start cards', () => {
  it('offers once per meeting, not on every tick', async () => {
    reading = { micApps: [zoom], events: [ev()] }
    await w.tick(); await w.tick(); await w.tick()
    expect(log).toHaveLength(1)
  })
  it('takes the card down when the call stops before a click, and offers again for a new call', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    reading = { micApps: [], events: [] }
    await w.tick()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos', 'hide', 'offer:app:us.zoom.xos'])
  })
  it('a closed card stays quiet while the app holds the mic, and is forgiven when it lets go', async () => {
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    w.dismiss('app:us.zoom.xos')
    await w.tick(); await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos'])
    reading = { micApps: [], events: [] }
    await w.tick()
    expect(w.dismissed.size).toBe(0)
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(2)
  })
  it('a helper process of the app does not forgive the dismissal', async () => {
    w.dismiss('app:us.zoom.xos')
    reading = { micApps: [{ bundleId: 'us.zoom.xos.helper', name: 'x' }], events: [], runningApps: ['us.zoom.xos'] }
    await w.tick()
    expect(w.dismissed.has('app:us.zoom.xos')).toBe(true)
  })
  it('a closed event card stays quiet for good', async () => {
    const e = ev()
    reading = { micApps: [zoom], events: [e] }
    await w.tick()
    w.dismiss(`event:e1:${e.start}`)
    reading = { micApps: [], events: [e] }; await w.tick()
    reading = { micApps: [zoom], events: [e] }; await w.tick()
    expect(log.filter((l) => l.startsWith('offer'))).toHaveLength(1)
  })
  it('no card while recording', async () => {
    active = meeting()
    reading = { micApps: [zoom], events: [] }
    await w.tick()
    expect(log).toEqual([])
  })
})

describe('stop nudge', () => {
  beforeEach(() => { active = meeting() })

  it('asks once after 30 s without the mic, not at 29 s', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }
    clock += 29_000; await w.tick()
    expect(log).toEqual([])
    clock += 1_000; await w.tick(); await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('takes the nudge down when the mic comes back', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 31_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 1_000; await w.tick()
    expect(log).toEqual(['stop', 'hide'])
  })
  it('Keep going snoozes for 5 minutes, then asks again', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 31_000; await w.tick()
    w.keepGoing()
    clock += 4 * MIN; await w.tick()
    expect(log).toEqual(['stop'])
    clock += 1.1 * MIN; await w.tick()
    expect(log).toEqual(['stop', 'stop'])
  })
  it('a meeting whose app is something else ignores other apps on the mic', async () => {
    reading = { micApps: [{ bundleId: 'com.hnc.Discord', name: 'Discord' }], events: [] }; await w.tick()
    clock += 31_000; await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('the event over by 5 minutes with 60 s of silence asks even with the mic busy', async () => {
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ eventId: 'e1' })
    reading = { micApps: [zoom], events: [e] }
    await w.tick()
    expect(log).toEqual([])
    silent = 60_000; await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('a meeting with no app: the mic rule never fires', async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('a meeting with no app still ends by the event rule', async () => {
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ app: null, eventId: 'e1' })
    reading = { micApps: [], events: [e] }; silent = 60_000
    await w.tick()
    expect(log).toEqual(['stop'])
  })
})

describe('stops by itself when the call ends', () => {
  beforeEach(() => { active = meeting(); auto = true; w = autoWatcher() })

  it('the call app lets go of the mic for 10 s: stops once, with no question', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }
    clock += 9_000; await w.tick()
    expect(log).toEqual([])
    clock += 1_000; await w.tick(); await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
  it('a recording started from the card counts the call it was offered for, even if the mic is gone by its first look', async () => {
    active = null
    reading = { micApps: [zoom], events: [] }; await w.tick()
    active = meeting()
    reading = { micApps: [], events: [] }; await w.tick()
    clock += 10_000; await w.tick()
    expect(log).toEqual(['offer:app:us.zoom.xos', 'auto:m1'])
  })
  it('a blip shorter than the grace does nothing', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 6_000; await w.tick()
    reading = { micApps: [zoom], events: [] }; clock += 3_000; await w.tick()
    reading = { micApps: [], events: [] }; clock += 6_000; await w.tick()
    expect(log).toEqual([])
  })
  it('a Meet tab: the browser letting go of the mic ends it', async () => {
    active = meeting({ app: 'Chrome' })
    reading = { micApps: [{ bundleId: 'com.google.Chrome.helper', name: 'Google Chrome Helper', title: 'Meet - abc' }], events: [], runningApps: ['com.google.Chrome'] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 10_000; await w.tick()
    expect(log).toEqual(['auto:m1'])
  })
  it('switched off: asks as before', async () => {
    auto = false
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 30_000; await w.tick()
    expect(log).toEqual(['stop'])
  })
  it('a recording started by hand with no call is never stopped', async () => {
    active = meeting({ app: null })
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('a resumed note whose call already ended is not stopped again', async () => {
    reading = { micApps: [], events: [] }
    await w.tick(); clock += 10 * MIN; await w.tick()
    expect(log.filter((l) => l.startsWith('auto'))).toEqual([])
  })
  it('the calendar event ending never stops it', async () => {
    const e = ev({ start: clock - 40 * MIN, end: clock - 10 * MIN })
    active = meeting({ eventId: 'e1' })
    reading = { micApps: [zoom], events: [e] }
    await w.tick(); clock += 30 * MIN; await w.tick()
    expect(log).toEqual([])
  })
  it('takes down a "Stop recording?" card that was up', async () => {
    auto = false
    reading = { micApps: [zoom], events: [] }; await w.tick()
    reading = { micApps: [], events: [] }; clock += 30_000; await w.tick()
    auto = true; await w.tick()
    expect(log).toEqual(['stop', 'hide', 'auto:m1'])
  })
})


describe('binding a call after any recording start', () => {
  beforeEach(() => { active = meeting({ app: null }); auto = true; w = autoWatcher() })
  it.each([zoom, { bundleId: 'us.zoom.CptHost', name: 'CptHost' }, { bundleId: 'com.apple.avconferenced', name: 'avconferenced' }])('binds $bundleId ten seconds after an agenda start and stops after the release grace', async (mic) => {
    const info = vi.spyOn(console, 'info')
    const appName = callAppName(callAppId(mic.bundleId)!)!
    await w.tick(); clock += 10_000
    reading = { micApps: [mic], events: [], runningApps: [callAppId(mic.bundleId)!] }; await w.tick()
    expect(active?.app).toBe(appName)
    reading = { micApps: [], events: [] }; clock += 9_999; await w.tick()
    expect(log).toEqual([])
    clock++; await w.tick(); await w.tick()
    expect(log).toEqual(['auto:m1'])
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      'CALL watch meeting=m1 app=none', `CALL bind meeting=m1 app=${appName} via=mic`, `CALL gone meeting=m1 app=${appName} idle_ms=10000`,
    ])
    info.mockRestore()
  })
  it('binds a call already on the mic, and does not switch to a different app', async () => {
    reading = { micApps: [zoom], events: [] }; await w.tick()
    expect(active?.app).toBe('Zoom')
    reading = { micApps: [{ bundleId: 'com.microsoft.teams2', name: 'Teams' }], events: [] }
    clock += 10_000; await w.tick()
    expect(active?.app).toBe('Zoom'); expect(log).toEqual(['auto:m1'])
  })
  it('uses a fresh pre-start observation once, including a dismissed offer', async () => {
    active = null; reading = { micApps: [zoom], events: [] }; await w.tick()
    w.dismiss('app:us.zoom.xos'); active = meeting({ app: null }); w.cleared()
    reading = { micApps: [], events: [] }; clock += 3000; await w.tick()
    expect(active?.app).toBe('Zoom')
    clock += 10_000; await w.tick(); expect(log.at(-1)).toBe('auto:m1')
  })
  it('does not bind an unrelated microphone app or an unqualified browser', async () => {
    reading = { micApps: [{ bundleId: 'com.apple.VoiceMemos', name: 'Voice Memos' }, { bundleId: 'com.google.Chrome', name: 'Chrome' }], events: [] }
    await w.tick(); expect(active?.app).toBeNull()
  })
  it('does not reuse an old call observation for a later recording', async () => {
    active = null; reading = { micApps: [zoom], events: [] }; await w.tick()
    clock += 60_000; active = meeting({ app: null }); reading = { micApps: [], events: [] }
    await w.tick(); expect(active?.app).toBeNull()
  })
})


it('does not keep a FaceTime recording alive for the shared daemon after FaceTime exits', async () => {
  active = meeting({ app: 'FaceTime' }); auto = true; w = autoWatcher()
  reading = { micApps: [{ bundleId: 'com.apple.avconferenced', name: 'avconferenced' }], events: [], runningApps: ['com.apple.FaceTime'] }
  await w.tick()
  reading.runningApps = []; clock += 10000; await w.tick()
  expect(log).toEqual(['auto:m1'])
})
