import { describe, expect, it } from 'vitest'
import { createPermissions, parseStatus, SETTINGS_URL } from '../src/main/permissions'
import { createMedia, MEDIA_APPS } from '../src/main/media'
import { trayItems } from '../src/main/trayMenu'
import { loginOnStart } from '../src/main/loginItem'

describe('permission status from the helper', () => {
  it('maps what the Mac says to granted, denied or unknown', () => {
    expect(parseStatus({ mic: 'authorized', systemAudio: 0, calendar: 'granted', accessibility: true })).toEqual({ mic: 'granted', systemAudio: 'granted', calendar: 'granted', accessibility: 'granted' })
    expect(parseStatus({ mic: 'denied', systemAudio: 1, calendar: 'denied', accessibility: false }, { axAsked: true })).toEqual({ mic: 'denied', systemAudio: 'denied', calendar: 'denied', accessibility: 'denied' })
    expect(parseStatus({ mic: 'restricted', systemAudio: 2, calendar: 'notDetermined', accessibility: false })).toEqual({ mic: 'restricted', systemAudio: 'unknown', calendar: 'unknown', accessibility: 'unknown' })
    // a Mac managed by an organisation: its own state, never Open System Settings
    expect(parseStatus({ calendar: 'restricted' }).calendar).toBe('restricted')
    expect(parseStatus({ mic: 'notDetermined' })).toEqual({ mic: 'unknown', systemAudio: 'unknown', calendar: 'unknown', accessibility: 'unknown' })
  })
  it('reads anything odd, or nothing, as unknown', () => {
    expect(parseStatus(null)).toEqual({ mic: 'unknown', systemAudio: 'unknown', calendar: 'unknown', accessibility: 'unknown' })
    expect(parseStatus({ mic: 7, systemAudio: 'x', calendar: {}, accessibility: 'yes' })).toEqual({ mic: 'unknown', systemAudio: 'unknown', calendar: 'unknown', accessibility: 'unknown' })
  })
  it('Accessibility: the Mac only says yes or no, so a no after asking once is off (Open System Settings), before it not asked', async () => {
    let asked = false
    const calls: string[][] = []
    const p = createPermissions({
      helper: async (a) => { calls.push(a); return a[0] === 'permissions' ? { accessibility: false } : { trusted: false } },
      notifications: () => 'unknown', askNotifications: async () => 'unknown', open: () => {}, axAsked: () => asked, setAxAsked: () => { asked = true },
    })
    expect((await p.status()).accessibility).toBe('unknown')
    expect(await p.request('accessibility')).toBe('denied')
    expect(calls.map((c) => c[0])).toEqual(['permissions', 'ax-auth', 'permissions'])
    expect(SETTINGS_URL.accessibility).toMatch(/Privacy_Accessibility$/)
  })
  it('a failing helper reads as unknown, never an error', async () => {
    const p = createPermissions({ helper: async () => { throw new Error('gone') }, notifications: () => 'unknown', askNotifications: async () => 'unknown', open: () => {} })
    expect(await p.status()).toEqual({ mic: 'unknown', systemAudio: 'unknown', calendar: 'unknown', accessibility: 'unknown', notifications: 'unknown' })
    expect(await p.request('mic')).toBe('unknown')
  })
  it('awaits the notification identity check without treating a confirmed post as authorization', async () => {
    const p = createPermissions({ helper: async () => ({}), notifications: async () => 'asked' as const, askNotifications: async () => 'asked', open: () => {} })
    expect((await p.status()).notifications).toBe('asked')
  })
  it('asks each one with its own helper command, and gives back the new status', async () => {
    const calls: string[][] = []
    const p = createPermissions({
      helper: async (a) => { calls.push(a); return a[0] === 'permissions' ? { mic: 'authorized', systemAudio: 0, calendar: 'granted' } : { status: 'granted' } },
      notifications: () => 'unknown', askNotifications: async () => 'granted', open: () => {},
    })
    expect(await p.request('mic')).toBe('granted')
    expect(await p.request('systemAudio')).toBe('granted')
    expect(await p.request('calendar')).toBe('granted')
    expect(await p.request('notifications')).toBe('granted')
    expect(calls.map((c) => c[0])).toEqual(['mic-auth', 'permissions', 'audio-auth', 'permissions', 'calendar-auth', 'permissions'])
  })
  it('opens the matching pane of System Settings', () => {
    const opened: string[] = []
    const p = createPermissions({ helper: async () => ({}), notifications: () => 'unknown', askNotifications: async () => 'unknown', open: (u) => opened.push(u) })
    p.openSettings('mic'); p.openSettings('calendar')
    expect(opened).toEqual([SETTINGS_URL.mic, SETTINGS_URL.calendar])
    expect(SETTINGS_URL.mic).toMatch(/^x-apple\.systempreferences:.*Microphone/)
  })
  it('registers the current Accessibility identity again before opening Settings', async () => {
    const calls: string[] = []
    const p = createPermissions({
      helper: async (a) => { calls.push(a[0]); return a[0] === 'permissions' ? { accessibility: false } : { trusted: false } },
      notifications: () => 'unknown', askNotifications: async () => 'unknown',
      open: (url) => calls.push(url), axAsked: () => true,
    })
    // Asked may come from a prior installation or a development launch attributed to the terminal.
    await p.openSettings('accessibility')
    expect(calls).toEqual(['ax-auth', SETTINGS_URL.accessibility])
    expect((await p.status()).accessibility).toBe('denied')
  })
  it('still opens Accessibility Settings when its prompt helper fails, without claiming access', async () => {
    const opened: string[] = []
    const p = createPermissions({
      helper: async () => { throw new Error('gone') }, notifications: () => 'unknown', askNotifications: async () => 'unknown',
      open: (url) => opened.push(url), axAsked: () => true,
    })
    await p.openSettings('accessibility')
    expect(opened).toEqual([SETTINGS_URL.accessibility])
    expect((await p.status()).accessibility).toBe('unknown')
  })
})

describe('permissions on Windows and Linux', () => {
  const offMac = (platform: string, o: { micBlocked?: () => boolean } = {}) => {
    const calls: string[][] = [], opened: string[] = []
    const p = createPermissions({ platform, ...o, helper: async (a) => { calls.push(a); return {} }, notifications: () => 'unknown', askNotifications: async () => 'unknown', open: (u) => opened.push(u) })
    return { p, calls, opened }
  }
  it('nothing needs asking: the mic, call audio and notifications are on, and no helper is asked', async () => {
    for (const platform of ['win32', 'linux']) {
      const { p, calls } = offMac(platform)
      expect(await p.status()).toEqual({ mic: 'granted', systemAudio: 'granted', calendar: 'unknown', accessibility: 'unknown', notifications: 'granted' })
      expect(await p.request('mic')).toBe('granted')
      expect(calls).toEqual([])
    }
  })
  it("Windows can block the mic in its Privacy settings: once the recorder said so it reads as off, and Settings opens Windows' microphone page", async () => {
    let blocked = true
    const { p, opened } = offMac('win32', { micBlocked: () => blocked })
    expect((await p.status()).mic).toBe('denied')
    await p.openSettings('mic')
    expect(opened).toEqual(['ms-settings:privacy-microphone'])
    blocked = false
    expect((await p.status()).mic).toBe('granted')
  })
  it('Linux has no settings page to open', async () => {
    const { p, opened } = offMac('linux')
    await p.openSettings('mic')
    expect(opened).toEqual([])
  })
  it('a Mac (no platform given, or darwin) works as before', async () => {
    const { p, calls } = offMac('darwin')
    await p.status()
    expect(calls).toEqual([['permissions']])
  })
})

describe('media pause', () => {
  const rig = (paused: unknown, slowMs = 0) => {
    const calls: string[][] = []
    const media = createMedia({ helper: async (a) => {
      calls.push(a)
      if (a[0] === 'media-pause') { await new Promise((r) => setTimeout(r, slowMs)); return paused }
      return { resumed: a.slice(1) }
    } })
    return { media, calls }
  }
  it('resumes only the apps it paused', async () => {
    const { media, calls } = rig({ paused: ['com.spotify.client'] })
    await media.pause(); await media.resume()
    expect(calls).toEqual([['media-pause'], ['media-resume', 'com.spotify.client']])
  })
  it('touches nothing on stop when nothing was playing', async () => {
    const { media, calls } = rig({ paused: [] })
    await media.pause(); await media.resume()
    expect(calls).toEqual([['media-pause']])
  })
  it('resumes once: a second stop does nothing', async () => {
    const { media, calls } = rig({ paused: ['com.apple.Music'] })
    await media.pause(); await media.resume(); await media.resume()
    expect(calls.filter((c) => c[0] === 'media-resume')).toHaveLength(1)
  })
  it('waits for a slow pause before resuming', async () => {
    const { media, calls } = rig({ paused: ['com.apple.Music'] }, 50)
    void media.pause()
    await media.resume()
    expect(calls).toEqual([['media-pause'], ['media-resume', 'com.apple.Music']])
  })
  it('ignores apps it does not know, and odd answers', async () => {
    const { media, calls } = rig({ paused: ['com.evil.app', 'com.apple.Music', 3] })
    await media.pause(); await media.resume()
    expect(calls.at(-1)).toEqual(['media-resume', 'com.apple.Music'])
    const odd = rig('nope'); await odd.media.pause(); await odd.media.resume()
    expect(odd.calls).toEqual([['media-pause']])
  })
  it('a stop never wipes the pause of the next recording', async () => {
    let n = 0
    const calls: string[][] = []
    const media = createMedia({ helper: async (a) => {
      calls.push(a)
      if (a[0] === 'media-pause') { const k = ++n; if (k === 1) await new Promise((r) => setTimeout(r, 40)); return { paused: [k === 1 ? 'com.apple.Music' : 'com.spotify.client'] } }
      return {}
    } })
    void media.pause()
    const stopped = media.resume()
    await media.pause()
    await stopped
    await media.resume()
    expect(calls.filter((c) => c[0] === 'media-resume')).toEqual([['media-resume', 'com.apple.Music'], ['media-resume', 'com.spotify.client']])
  })
  it('says when it still has music to play again (quitting waits for it)', async () => {
    const { media } = rig({ paused: ['com.apple.Music'] })
    expect(media.holding()).toBe(false)
    const p = media.pause()
    expect(media.holding()).toBe(true)
    await p
    expect(media.holding()).toBe(true)
    await media.resume()
    expect(media.holding()).toBe(false)
  })
  it('fails quietly', async () => {
    const media = createMedia({ helper: async () => { throw new Error('no automation permission') } })
    await expect(media.pause()).resolves.toBeUndefined()
    await expect(media.resume()).resolves.toBeUndefined()
  })
  it('knows Music and Spotify', () => expect(MEDIA_APPS).toEqual(expect.arrayContaining(['com.apple.Music', 'com.spotify.client'])))
})

describe('open at login on start', () => {
  it('registers again only when it should be on and the Mac lost it (app moved or reinstalled)', () => {
    expect(loginOnStart(true, 'not-registered')).toBe('register')
    expect(loginOnStart(true, 'not-found')).toBe('register')
    // turned off in System Settings, or waiting for the person: theirs to decide
    expect(loginOnStart(true, 'requires-approval')).toBe('none')
    expect(loginOnStart(true, 'enabled')).toBe('none')
    expect(loginOnStart(false, 'enabled')).toBe('unregister')
    expect(loginOnStart(undefined, 'enabled')).toBe('none')
    expect(loginOnStart(false, 'not-registered')).toBe('none')
  })
})

describe('menu bar menu', () => {
  it('not recording: open, new note, quit', () => {
    expect(trayItems(null).map((i) => i.id)).toEqual(['new', 'ask', 'recent', 'sep', 'open', 'settings', 'sep', 'quit'])
  })
  it('recording: says so, and offers stop instead of new note', () => {
    const items = trayItems({ id: 'm1', title: 'Weekly sync' })
    expect(items.map((i) => i.id)).toEqual(['status', 'pause', 'stop', 'sep', 'ask', 'open', 'recent', 'settings', 'sep', 'quit'])
    expect(items[0]).toMatchObject({ label: 'Recording: Weekly sync', enabled: false })
  })
  it('paused: describes the retained recording accurately and still offers finish', () => {
    const items = trayItems({ id: 'm1', title: 'Weekly sync', paused: true })
    expect(items[0]).toMatchObject({ label: 'Paused: Weekly sync', enabled: false })
    expect(items.map((i) => i.id)).toEqual(['status', 'pause', 'stop', 'sep', 'ask', 'open', 'recent', 'settings', 'sep', 'quit'])
  })
})

describe('music on quit', () => {
  it('resuming never holds up quitting for more than its cap', async () => {
    const media = createMedia({ helper: async (a) => (a[0] === 'media-pause' ? { paused: ['com.apple.Music'] } : new Promise(() => {})) })
    await media.pause()
    const t0 = Date.now()
    await media.resume(50)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('a pause that never answers does not hold it up either', async () => {
    const media = createMedia({ helper: () => new Promise(() => {}) })
    void media.pause()
    const t0 = Date.now()
    await media.resume(50)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
