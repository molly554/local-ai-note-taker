import { useCallback, useEffect, useRef, useState } from 'react'
import type { Access, PermissionKind } from '../../shared/types'
import { viaSystemSettings } from '../../shared/onboarding'

/** asking: the Mac's prompt is up; away: System Settings is open and Yogurt waits for it to be turned on; back: turned on there */
export type FlowPhase = 'idle' | 'asking' | 'away' | 'back' | 'failed'
const POLL_MS = 1500
const on = (a: Access | undefined) => a === 'granted' || a === 'asked'

/**
 * One permission, from Allow to on: the Mac's own prompt where there is one, else its pane of System Settings, then
 * watching for it (on focus, and every 1.5 s while away) so coming back finds it already noticed.
 * done: called when it is on straight away (the prompt said yes); after a trip to System Settings the phase is back instead.
 */
export function usePermissionFlow(kind: PermissionKind, initial: Access | undefined, done?: () => void) {
  const [status, setStatus] = useState<Access | undefined>(initial)
  const [phase, setPhase] = useState<FlowPhase>('idle')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => { setStatus(initial); setPhase('idle') }, [kind])

  const recheck = useCallback(async () => {
    try {
      const st = (await window.yogurt.permissions.status())[kind]
      setStatus(st)
      if (phaseRef.current === 'away' && on(st)) setPhase('back')
      else if (phaseRef.current === 'failed') setPhase('idle')
    } catch { setPhase('failed') }
  }, [kind])

  useEffect(() => {
    const f = () => void recheck()
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  }, [recheck])
  useEffect(() => {
    if (phase !== 'away') return
    const timer = setInterval(() => void recheck(), POLL_MS)
    return () => clearInterval(timer)
  }, [phase, recheck])

  const openSettings = useCallback(async () => {
    setPhase('away')
    try { await window.yogurt.permissions.open(kind) } catch { setPhase('failed') }
  }, [kind])

  const allow = useCallback(async () => {
    if (phaseRef.current === 'asking') return
    if (on(status)) { done?.(); return }
    if (viaSystemSettings(kind, status ?? 'unknown')) return openSettings()
    setPhase('asking')
    try {
      const st = await window.yogurt.permissions.request(kind)
      setStatus(st)
      if (on(st)) { setPhase('idle'); done?.(); return }
      // said no in the Mac's prompt: from now on only System Settings turns it on
      setPhase(st === 'unknown' ? 'failed' : 'idle')
    } catch { setPhase('failed') }
  }, [kind, status, done, openSettings])

  /** stop waiting (the guide was closed); focus still notices it later */
  const stop = useCallback(() => setPhase('idle'), [])

  return { status, phase, allow, openSettings, recheck, stop }
}
