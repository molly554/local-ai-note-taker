import { describe, expect, it } from 'vitest'
import { bootHoldMs, BOOT, finishSetupPercent, firstRunPlan, isEssential, missing, nudge, screensOf, viaSystemSettings } from '../src/shared/onboarding'
import { capabilities, supportedKinds } from '../src/shared/platform'
import type { PermissionStatus } from '../src/shared/types'

const all = (a: PermissionStatus[keyof PermissionStatus]): PermissionStatus => ({ mic: a, systemAudio: a, calendar: a, notifications: a, accessibility: a })

describe('first run', () => {
  it('a new Mac: the intro, then one step per permission, in order, and no open-at-login step', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: false, status: all('unknown') })
    expect(plan.intro).toBe(true)
    expect(plan.steps.map((s) => s.kind)).toEqual(['mic', 'systemAudio', 'calendar', 'notifications', 'accessibility'])
    expect(plan.steps.every((s) => s.status === 'unknown')).toBe(true)
  })
  it('skips what is on, asked already or decided by an organisation; denied ones stay (System Settings)', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: false, status: { mic: 'granted', systemAudio: 'denied', calendar: 'restricted', notifications: 'asked', accessibility: 'unknown' } })
    expect(plan.steps).toEqual([{ kind: 'systemAudio', status: 'denied' }, { kind: 'accessibility', status: 'unknown' }])
  })
  it('nothing after it was shown once, or when this run may not ask', () => {
    expect(firstRunPlan({ ask: true, welcomed: true, introSeen: true, status: all('unknown') })).toEqual({ intro: false, steps: [] })
    expect(firstRunPlan({ ask: false, welcomed: false, introSeen: false, status: all('unknown') })).toEqual({ intro: false, steps: [] })
  })
  it('the intro once: reopened halfway through (say, after a restart for a permission), it goes on with the permissions', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: true, status: { ...all('unknown'), mic: 'granted' } })
    expect(plan.intro).toBe(false)
    expect(plan.steps[0].kind).toBe('systemAudio')
  })
})

describe('first-run screens', () => {
  it('the mic and call audio share one screen (both hear the call); the rest get one each, in order', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: false, status: all('unknown') })
    expect(screensOf(plan.steps).map((s) => [s.id, s.steps.map((x) => x.kind)])).toEqual([
      ['record', ['mic', 'systemAudio']], ['calendar', ['calendar']], ['notifications', ['notifications']], ['accessibility', ['accessibility']],
    ])
  })
  it('a screen with nothing left to ask is left out; one with half of it left asks only that half', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: false, status: { ...all('granted'), systemAudio: 'denied', accessibility: 'unknown' } })
    const screens = screensOf(plan.steps)
    expect(screens.map((s) => s.id)).toEqual(['record', 'accessibility'])
    expect(screens[0].kinds).toEqual(['mic', 'systemAudio'])
    expect(screens[0].steps).toEqual([{ kind: 'systemAudio', status: 'denied' }])
  })
})

describe('what is essential', () => {
  it('recording needs the mic and the call audio; the rest makes it better', () => {
    expect(['mic', 'systemAudio'].every((k) => isEssential(k as never))).toBe(true)
    expect(['calendar', 'notifications', 'accessibility'].some((k) => isEssential(k as never))).toBe(false)
  })
  it('only System Settings can turn on Accessibility, or anything turned off before', () => {
    expect(viaSystemSettings('accessibility', 'unknown')).toBe(true)
    expect(viaSystemSettings('mic', 'denied')).toBe(true)
    expect(viaSystemSettings('mic', 'unknown')).toBe(false)
    expect(viaSystemSettings('systemAudio', 'unknown')).toBe(false)
  })
})

describe('the Finish setup nudge', () => {
  it('lists what is still off, essential first, never what is on, asked or managed', () => {
    const st: PermissionStatus = { mic: 'granted', systemAudio: 'unknown', calendar: 'denied', notifications: 'asked', accessibility: 'unknown' }
    expect(missing(st)).toEqual([
      { kind: 'systemAudio', status: 'unknown', essential: true },
      { kind: 'accessibility', status: 'unknown', essential: false },
    ])
    expect(missing({ ...all('granted'), calendar: 'restricted' })).toEqual([])
  })
  it('the essential ones before the optional ones, whatever their order in Settings', () => {
    expect(missing({ ...all('granted'), notifications: 'unknown', mic: 'denied' }).map((m) => m.kind)).toEqual(['mic', 'notifications'])
  })
  it('hides when only Calendar is missing, including after an older dismissal', () => {
    for (const calendar of ['unknown', 'denied'] as const) {
      const st = { ...all('granted'), calendar }
      expect(missing(st)).toEqual([])
      expect(nudge(st, [])).toEqual([])
      expect(nudge(st, ['calendar'])).toEqual([])
    }
    expect(missing(all('unknown')).map(m => m.kind)).toEqual(['mic', 'systemAudio', 'notifications', 'accessibility'])
  })
  it('stays away once dismissed, and comes back only when something new is missing', () => {
    const st: PermissionStatus = { ...all('granted'), calendar: 'unknown', accessibility: 'unknown' }
    expect(nudge(st, []).map((m) => m.kind)).toEqual(['accessibility'])
    expect(nudge(st, ['calendar', 'accessibility'])).toEqual([])
    // the mic was turned off later: everything missing is listed again
    expect(nudge({ ...st, mic: 'denied' }, ['calendar', 'accessibility']).map((m) => m.kind)).toEqual(['mic', 'accessibility'])
    expect(nudge(all('granted'), [])).toEqual([])
  })
})

describe('the launch screen', () => {
  it('never shows for a quick start', () => {
    expect(bootHoldMs(0)).toBe(0)
    expect(bootHoldMs(BOOT.showAfterMs - 1)).toBe(0)
  })
  it('once shown, stays long enough to be seen, then goes as soon as the app is ready', () => {
    expect(bootHoldMs(BOOT.showAfterMs)).toBe(BOOT.minShownMs)
    expect(bootHoldMs(BOOT.showAfterMs + 200)).toBe(BOOT.minShownMs - 200)
    expect(bootHoldMs(BOOT.showAfterMs + BOOT.minShownMs + 500)).toBe(0)
  })
})

describe('a computer without a calendar or names from calls (Windows, Linux)', () => {
  const kinds = supportedKinds(capabilities('win32'))
  it('the first run never asks for them', () => {
    const plan = firstRunPlan({ ask: true, welcomed: false, introSeen: false, status: all('unknown'), kinds })
    expect(screensOf(plan.steps).map((s) => s.id)).toEqual(['record', 'notifications'])
  })
  it('Finish setup leaves them out of the list and the progress', () => {
    const st: PermissionStatus = { ...all('granted'), accessibility: 'unknown', calendar: 'unknown' }
    expect(missing(st, kinds)).toEqual([])
    expect(nudge(st, [], kinds)).toEqual([])
    expect(finishSetupPercent(st, kinds)).toBe(100)
  })
  it('a Mac is unchanged: its own list is the default', () => {
    const st: PermissionStatus = { ...all('granted'), accessibility: 'unknown' }
    expect(missing(st, supportedKinds(capabilities('darwin'))).map((m) => m.kind)).toEqual(['accessibility'])
    expect(finishSetupPercent(st, supportedKinds(capabilities('darwin')))).toBe(finishSetupPercent(st))
  })
})
