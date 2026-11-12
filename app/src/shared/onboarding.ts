import { PERMISSION_KINDS } from '../main/permissions'
import type { Access, OnboardingPlan, OnboardingStep, PermissionKind, PermissionStatus } from './types'

/** Recording needs these two; calendar, notifications and names from calls only make it better */
export const ESSENTIAL: readonly PermissionKind[] = ['mic', 'systemAudio']
export const isEssential = (k: PermissionKind) => ESSENTIAL.includes(k)

/** still something the person can say yes to: not on, not asked already (notifications), not decided by an organisation */
const open = (a: Access) => a === 'unknown' || a === 'denied'

/**
 * The first run: the intro (once, even if Yogurt reopens halfway), then one step per permission still open, in order.
 * ask: whether this run may show it at all (fake mode only when a test sets the permissions).
 * kinds: the permissions this computer has (supportedKinds in platform.ts); a Mac has them all.
 */
export function firstRunPlan(o: { ask: boolean; welcomed: boolean; introSeen: boolean; status: PermissionStatus; kinds?: readonly PermissionKind[] }): OnboardingPlan {
  if (!o.ask || o.welcomed) return { intro: false, steps: [] }
  const steps: OnboardingStep[] = (o.kinds ?? PERMISSION_KINDS).filter((k) => open(o.status[k])).map((kind) => ({ kind, status: o.status[kind] }))
  return { intro: !o.introSeen, steps }
}

/** The first run's screens: the mic and the call audio are one idea (hearing the call), so one screen asks for both */
export type ScreenId = 'record' | 'calendar' | 'notifications' | 'accessibility'
export const SCREENS: readonly { id: ScreenId; kinds: readonly PermissionKind[] }[] = [
  { id: 'record', kinds: ['mic', 'systemAudio'] },
  { id: 'calendar', kinds: ['calendar'] },
  { id: 'notifications', kinds: ['notifications'] },
  { id: 'accessibility', kinds: ['accessibility'] },
]
export type OnboardingScreen = { id: ScreenId; kinds: readonly PermissionKind[]; steps: OnboardingStep[] }
/** the screens with something still to ask, each with only what is left */
export function screensOf(steps: readonly OnboardingStep[]): OnboardingScreen[] {
  return SCREENS.map((s) => ({ ...s, steps: steps.filter((x) => s.kinds.includes(x.kind)) })).filter((s) => s.steps.length > 0)
}

/** Accessibility is only ever turned on in System Settings; anything turned off before can only be turned back on there */
export const viaSystemSettings = (k: PermissionKind, a: Access) => a === 'denied' || k === 'accessibility'

export type Missing = { kind: PermissionKind; status: Access; essential: boolean }
/** Calendar connection lives in the Meetings agenda instead of this checklist. */
export const FINISH_SETUP_KINDS = PERMISSION_KINDS.filter(k => k !== 'calendar')
const finishKinds = (kinds: readonly PermissionKind[]) => FINISH_SETUP_KINDS.filter((k) => kinds.includes(k))
/** Managed permissions are not tasks this person can complete; asked notifications finish that setup step. */
export function finishSetupPercent(st: PermissionStatus, kinds: readonly PermissionKind[] = PERMISSION_KINDS): number {
  const applicable = finishKinds(kinds).filter(k => st[k] !== 'restricted')
  return applicable.length ? Math.round(applicable.filter(k => !open(st[k])).length * 100 / applicable.length) : 100
}
/** what is still off after the first run, the essential ones first */
export function missing(st: PermissionStatus, kinds: readonly PermissionKind[] = PERMISSION_KINDS): Missing[] {
  const list = finishKinds(kinds).filter((k) => open(st[k])).map((kind) => ({ kind, status: st[kind], essential: isEssential(kind) }))
  return [...list.filter((m) => m.essential), ...list.filter((m) => !m.essential)]
}

/** Home's "Finish setup": what is missing, unless the person put away exactly this (or more); something new brings it back */
export function nudge(st: PermissionStatus, dismissed: readonly PermissionKind[], kinds: readonly PermissionKind[] = PERMISSION_KINDS): Missing[] {
  const list = missing(st, kinds)
  return list.every((m) => dismissed.includes(m.kind)) ? [] : list
}

/** The launch screen: only after a short wait, so a quick start never flashes it; once shown, long enough to see */
export const BOOT = { showAfterMs: 300, minShownMs: 700 }
/** how much longer the launch screen stays once the app was ready readyAt ms after the page started */
export function bootHoldMs(readyAt: number): number {
  if (readyAt < BOOT.showAfterMs) return 0
  return Math.max(0, BOOT.showAfterMs + BOOT.minShownMs - readyAt)
}
