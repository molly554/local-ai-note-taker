import { describe, expect, it } from 'vitest'
import { createSignals } from '../src/main/detectSignals'

const chrome = { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 1 }
const zoom = { bundleId: 'us.zoom.xos', name: 'zoom.us', pid: 2 }
const webkit = { bundleId: 'com.apple.WebKit.WebContent', name: 'WebContent', pid: 3 }

function setup(o: { mic?: unknown[]; title?: string | null; running?: string[] } = {}) {
  const calls: string[][] = []
  let mic = o.mic ?? [], title = o.title === undefined ? 'Meet - abc-defg-hij' : o.title, eventCalls = 0
  const s = createSignals({
    helper: async (args) => { calls.push(args); return args[0] === 'mic-apps' ? mic : args[0] === 'running-apps' ? o.running ?? ['com.apple.Safari'] : { title } },
    events: async () => { eventCalls++; return [] },
  })
  return { s, calls, setMic: (m: unknown[]) => { mic = m }, setTitle: (t: string | null) => { title = t }, events: () => eventCalls,
    titleCalls: () => calls.filter((c) => c[0] === 'browser-title') }
}

describe('createSignals', () => {
  it('asks for a browser tab title only while that browser is on the mic, and passes it on', async () => {
    const x = setup({ mic: [chrome] })
    const r = await x.s.read(0)
    expect(r.micApps[0]).toMatchObject({ bundleId: 'com.google.Chrome', title: 'Meet - abc-defg-hij' })
    expect(x.titleCalls()).toEqual([['browser-title', 'com.google.Chrome']])
  })
  it('does not ask for a title for a call app, or when nothing is on the mic', async () => {
    const x = setup({ mic: [zoom] })
    await x.s.read(0); x.setMic([]); await x.s.read(1000)
    expect(x.titleCalls()).toEqual([])
  })
  it('safari\'s web process asks Safari for the title', async () => {
    const x = setup({ mic: [webkit] })
    await x.s.read(0)
    expect(x.titleCalls()).toEqual([['browser-title', 'com.apple.Safari']])
  })
  it('keeps a title for 10 s, then asks again', async () => {
    const x = setup({ mic: [chrome] })
    await x.s.read(0); x.setTitle('YouTube')
    expect((await x.s.read(9_000)).micApps[0].title).toBe('Meet - abc-defg-hij')
    expect((await x.s.read(10_500)).micApps[0].title).toBe('YouTube')
    expect(x.titleCalls()).toHaveLength(2)
  })
  it('a browser with no title (Firefox, no permission) has none', async () => {
    const x = setup({ mic: [{ bundleId: 'org.mozilla.firefox', name: 'Firefox', pid: 4 }], title: null })
    expect((await x.s.read(0)).micApps[0].title).toBeUndefined()
    expect(x.titleCalls()).toEqual([['browser-title', 'org.mozilla.firefox']])
  })
  it('reads the calendar at most once a minute', async () => {
    const x = setup()
    await x.s.read(0); await x.s.read(59_000)
    expect(x.events()).toBe(1)
    await x.s.read(61_000)
    expect(x.events()).toBe(2)
  })
  it('reads again immediately when calendar selection changes', async () => {
    const x = setup()
    await x.s.read(0)
    x.s.invalidateCalendar()
    await x.s.read(1000)
    expect(x.events()).toBe(2)
  })
  it('does not cache a calendar read started before selection changed', async () => {
    let finish!: (events: []) => void
    let calls = 0
    const s = createSignals({ helper: async () => [], events: () => {
      calls++
      return new Promise<[]>((resolve) => { finish = resolve })
    } })
    const first = s.read(0)
    await Promise.resolve()
    s.invalidateCalendar()
    finish([])
    await first
    const second = s.read(1000)
    await Promise.resolve()
    expect(calls).toBe(2)
    finish([])
    await second
  })
  it('the override wins and skips the helper', async () => {
    const x = setup({ mic: [zoom] })
    x.s.override({ micApps: [], events: [] })
    expect((await x.s.read(0)).micApps).toEqual([])
    expect(x.calls).toEqual([])
  })
})


it('checks a shared daemon owner using the native running-apps command', async () => {
  const x = setup({ mic: [{ bundleId: 'com.apple.avconferenced', name: 'avconferenced' }], running: ['com.apple.FaceTime'] })
  expect((await x.s.read(0)).runningApps).toEqual(['com.apple.FaceTime'])
  expect(x.calls).toContainEqual(['running-apps', 'com.apple.FaceTime'])
})
it('does not turn a failed owner lookup into a false call end', async () => {
  const x = createSignals({ helper: async args => args[0] === 'mic-apps' ? [{ bundleId: 'com.apple.avconferenced' }] : null, events: async () => [] })
  await expect(x.read(0)).rejects.toThrow('Could not read running call apps')
})
