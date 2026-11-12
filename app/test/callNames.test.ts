import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Meeting, type Store } from '../src/main/store'
import { hookCallNames, watchIds, type WatchLine } from '../src/main/callNames'
import type { AxNode } from '../src/main/callNames/parse'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })

/** Zoom's meeting window with these tiles; the talking one marked */
const zoomLine = (t: number, people: string[], talking?: string, me?: string): WatchLine => ({
  t, app: 'us.zoom.xos', windows: [{ id: 'zm.meeting.window.main', tree: { r: 'AXWindow', k: [
    ...people.map((p): AxNode => ({ r: 'AXTabGroup', d: `${p}, Computer audio unmuted${p === talking ? ', Active speaker' : ''}` })),
    ...(me ? [{ r: 'AXOutline', d: 'Participants list', k: [{ r: 'AXRow', k: [{ r: 'AXStaticText', v: `${me} (me)` }] }] } as AxNode] : []),
  ] } }],
})

function setup(o: { app?: string | null; attendees?: Meeting['attendees'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-callnames-')); dirs.push(root)
  const store = openStore(join(root, 'yogurt.db')); stores.push(store)
  const m = store.createMeeting({ title: 'Sync', startedAt: 1_000_000, endedAt: null, eventId: null, app: o.app === undefined ? 'Zoom' : o.app, attendees: o.attendees ?? [], state: 'recording' })
  let clock = 1_000_000
  const watched: string[][] = []
  let emit!: (l: WatchLine) => void
  let stopped = 0
  const starts: Array<(m: Meeting) => void> = [], stops: Array<(m: Meeting) => void> = []
  const captures: Array<(c: EventEmitter, id: string) => void> = []
  const changed: string[] = [], logs: string[] = []
  let transcribed!: () => void
  const done = new Promise<void>((r) => { transcribed = r })
  const hook = hookCallNames({
    store, myNames: () => ['Alex Morgan'], transcribed: () => done, changed: (id) => changed.push(id), log: (s) => logs.push(s), now: () => clock,
    watch: (ids, onLine) => { watched.push(ids); emit = onLine; return { stop: () => { stopped++ } } },
    onStart: (fn) => starts.push(fn), onStop: (fn) => stops.push(fn), onCapture: (fn) => captures.push(fn),
  })
  const capture = new EventEmitter()
  return {
    store, m, hook, watched, changed, logs, transcribed, stopped: () => stopped,
    start() { starts.forEach((f) => f(m)); captures.forEach((f) => f(capture, m.id)) },
    /** audio heard: meeting time `ms`, arriving at wall clock `at` */
    audio(ms: number, at: number) { clock = at; capture.emit('pcm', 'them', ms, new Float32Array(1600)) },
    emit: (l: WatchLine) => emit(l),
    stop() { const s = { ...store.meeting(m.id)!, state: 'stopped' as const }; stops.forEach((f) => f(s)) },
  }
}
const wait = () => new Promise((r) => setTimeout(r, 10))

describe('watchIds: only the call app the meeting is in', () => {
  it('maps the detected app to its bundle ids; no app known: every call app (the frontmost with a call is read)', () => {
    expect(watchIds('Zoom')).toEqual(['us.zoom.xos'])
    expect(watchIds('Teams')).toEqual(['com.microsoft.teams2', 'com.microsoft.teams'])
    expect(watchIds('Chrome')).toEqual(['com.google.Chrome'])
    expect(watchIds('Safari')).toEqual(['com.apple.Safari'])
    expect(watchIds('FaceTime')).toEqual([])
    expect(watchIds(null)).toContain('us.zoom.xos')
    expect(watchIds(null)).toContain('org.mozilla.firefox')
  })
})

describe('hookCallNames', () => {
  it('a resumed session names only new lines and preserves previous speaker labels', async () => {
    const s = setup()
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'Prior session.', speaker: 'Ann Lee' }])
    s.start(); s.audio(10_000, 2_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 11_000, endMs: 13_000, text: 'New session.', speaker: null }])
    for (let t = 2_000_000; t < 2_010_000; t += 500) s.emit(zoomLine(t, ['Bo Park'], 'Bo Park'))
    s.stop(); s.transcribed(); await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((line) => line.speaker)).toEqual(['Ann Lee', 'Bo Park'])
  })

  it('reads the meeting\'s app while it records, and a line of the other side gets the name talking then', () => {
    const s = setup()
    s.start()
    expect(s.watched).toEqual([['us.zoom.xos']])
    // meeting time 0 was heard at 1_005_000 (the 100 ms of audio arrived 100 ms after it started)
    s.audio(0, 1_005_100)
    for (let t = 1_006_000; t < 1_014_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], t < 1_010_000 ? 'Dana Smith' : 'Ann Lee'))
    // Zoom marks a little late: 1.75 s to 4.25 s of the meeting is Dana's
    expect(s.hook.nameFor(s.m.id, 1500, 4000)).toBe('Dana Smith')
    expect(s.hook.nameFor(s.m.id, 6000, 8000)).toBe('Ann Lee')
    expect(s.hook.nameFor('other', 1500, 4000)).toBeNull()
  })

  it('after the meeting every line of the other side is named again from the whole timeline; new people join the attendees', async () => {
    const s = setup({ attendees: [{ name: 'Dana Smith', email: 'dana@example.com' }] })
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([
      { meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'early', speaker: null },
      { meetingId: s.m.id, track: 'me', startMs: 3000, endMs: 4000, text: 'mine', speaker: 'me' },
      { meetingId: s.m.id, track: 'them', startMs: 6000, endMs: 8000, text: 'later', speaker: null },
    ])
    for (let t = 1_000_000; t < 1_010_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], t < 1_005_000 ? 'Dana Smith' : 'Ann Lee', 'Alex Morgan'))
    s.stop()
    expect(s.stopped()).toBe(1)
    s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id).map((x) => x.speaker)).toEqual(['Dana Smith', 'me', 'Ann Lee'])
    expect(s.store.meeting(s.m.id)!.attendees).toEqual([{ name: 'Dana Smith', email: 'dana@example.com' }, { name: 'Ann Lee', email: null }])
    expect(s.changed).toEqual([s.m.id])
    // the first reading is pictured in the log, for a real call's data
    expect(s.logs.some((l) => l.includes('AXTabGroup'))).toBe(true)
  })

  it('without Accessibility, or with nothing read, every line stays Them and nothing changes', async () => {
    const s = setup()
    s.start()
    s.audio(0, 1_000_100)
    s.store.addSegments([{ meetingId: s.m.id, track: 'them', startMs: 1000, endMs: 3000, text: 'hello', speaker: null }])
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit({ t, error: 'not-trusted' })
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBeNull()
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
    expect(s.store.segments(s.m.id)[0].speaker).toBeNull()
    expect(s.changed).toEqual([])
    // said once, not on every reading
    expect(s.logs.filter((l) => l.includes('not-trusted'))).toHaveLength(1)
  })

  it('a meeting in an app it can\'t read starts no watch', async () => {
    const s = setup({ app: 'FaceTime' })
    s.start()
    expect(s.watched).toEqual([])
    s.stop(); s.transcribed()
    await s.hook.finished(s.m.id)
  })

  it('the name in Settings is never given to the other side', async () => {
    const s = setup()
    s.start()
    s.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) s.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith', 'Ann Lee'], 'Alex Morgan'))
    expect(s.hook.nameFor(s.m.id, 1000, 3000)).toBeNull()
    // and a call of two with that name is the other person's whatever is marked
    const p = setup()
    p.start()
    p.audio(0, 1_000_100)
    for (let t = 1_000_000; t < 1_005_000; t += 500) p.emit(zoomLine(t, ['Alex Morgan', 'Dana Smith']))
    expect(p.hook.nameFor(p.m.id, 1000, 3000)).toBe('Dana Smith')
    await wait()
  })
})
