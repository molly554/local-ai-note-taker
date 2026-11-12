import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { OnboardingPlan, OnboardingStep, PermissionKind, SetupState } from '../../../shared/types'
import { screensOf, viaSystemSettings, type OnboardingScreen } from '../../../shared/onboarding'
import { Wordmark } from '../components/Logo'
import { ReadyArt, ScreenArt, WelcomeArt } from '../components/OnboardingArt'
import { SettingsArt } from '../components/SettingsGuide'
import { SetupStatus, transcriptionPhase, transcriptionPercent } from '../components/SetupStatus'
import { permissionCopy, screenCopy } from '../permissionCopy'
import { usePermissionFlow } from '../permissionFlow'
import { t } from '../../../shared/i18n'

/**
 * First run: one welcome screen, then one screen per idea still to ask (the mic and the call audio share one), each
 * with a picture of what it does. Every one can be put off ("Not now"); home's Finish setup and Settings have them
 * again. Then the download, if it isn't done yet. The models keep downloading in the background the whole time.
 */
export function Onboarding({ state, plan, onDone }: { state: SetupState; plan: OnboardingPlan; onDone(): void }) {
  const screens = useMemo(() => screensOf(plan.steps), [plan])
  const [stage, setStage] = useState<'intro' | 'steps' | 'progress'>(plan.intro ? 'intro' : screens.length ? 'steps' : 'progress')
  const [i, setI] = useState(0)
  const finish = () => { setStage('progress'); void window.yogurt.onboarding.done().finally(onDone) }
  const introDone = () => {
    void window.yogurt.onboarding.introSeen()
    if (screens.length) setStage('steps'); else finish()
  }
  const next = () => { if (i + 1 < screens.length) setI(i + 1); else finish() }
  const screen = screens[i]
  // the welcome counts as the first step, so the bar shows how much is left from the start
  const first = plan.intro ? 1 : 0
  const progress = { n: stage === 'intro' ? 0 : first + i, total: first + screens.length }
  return (
    <div data-testid="onboarding" data-phase={state.phase} data-stage={stage} className="setup-screen">
      {stage === 'intro' ? <Welcome state={state} progress={progress} onDone={introDone} />
        : stage === 'steps' && screen ? <PermissionScreen key={screen.id} screen={screen} state={state} progress={progress} onNext={next} />
          : <Ready state={state} />}
    </div>
  )
}

type Progress = { n: number; total: number }

/**
 * Every screen of the first run: the words on one side, the picture on the other. The headline, the sentence and the
 * buttons sit in the same place on every screen; the note under the buttons has its own room so nothing moves.
 * motionKey: a change fades the words in again; its part before ":" does the same for the picture.
 */
function Layout({ testId, step, kind, motionKey, art, title, text, textTestId = 'step-reason', actions, note, progress, state }: {
  testId: string; step?: string; kind?: string; motionKey: string; art: ReactNode; title: string; text: string; textTestId?: string
  actions: ReactNode; note?: ReactNode; progress?: Progress; state?: SetupState
}) {
  return (
    <section data-testid={testId} data-step={step} data-kind={kind} className="ob">
      <div className="ob-side">
        {step !== 'welcome' && <div className="ob-brand"><Wordmark height={22} /></div>}
        <div className="ob-main">
          <div key={motionKey} className="ob-copy">
            {step === 'welcome' && <div className="ob-brand ob-intro-brand"><Wordmark height={22} /></div>}
            <h1 data-testid="step-title" className="ob-title"><span>{title}</span></h1>
            <p id="step-reason" data-testid={textTestId} className="ob-text">{text}</p>
            <div className="ob-actions">{actions}</div>
            <div className="ob-note-slot">{note}</div>
          </div>
        </div>
        <div className="ob-foot">
          {progress && <Steps {...progress} />}
          {state && <SetupStatus state={state} />}
        </div>
      </div>
      <div className="ob-stage" aria-hidden="true">
        <div key={motionKey} className="ob-stage-art">{art}</div>
      </div>
    </section>
  )
}

/** A quiet bar of segments: the ones done and this one filled, the rest waiting */
function Steps({ n, total }: Progress) {
  return (
    <div className="ob-steps" role="img" aria-label={t('Step {n} of {total}', { n: n + 1, total })}>
      {Array.from({ length: total }, (_, k) => <span key={k} data-done={k <= n} />)}
    </div>
  )
}

/** The keyboard focus goes to the main button whenever what it does changes, so Enter answers and a screen reader reads it */
function useFocus(ref: RefObject<HTMLButtonElement | null>, deps: unknown[]) {
  useEffect(() => { ref.current?.focus() }, deps)
}

/** What Yogurt is, in the website's words */
function Welcome({ state, progress, onDone }: { state: SetupState; progress: Progress; onDone(): void }) {
  const c = screenCopy('welcome')
  const primary = useRef<HTMLButtonElement>(null)
  useFocus(primary, [])
  return (
    <Layout
      testId="intro-page" step="welcome" motionKey="welcome" art={<WelcomeArt />} title={c.title} text={c.text} progress={progress} state={state}
      actions={<button ref={primary} data-testid="intro-next" onClick={onDone} className="ob-button primary no-drag">{t('Get started')}</button>}
    />
  )
}

/**
 * One screen of permissions, asked one after the other: one Allow asks for the mic, then straight away for the call
 * audio. One turned off before waits for a click instead, since only System Settings can turn it on.
 */
function PermissionScreen({ screen, state, progress, onNext }: { screen: OnboardingScreen; state: SetupState; progress: Progress; onNext(): void }) {
  const [k, setK] = useState(0)
  const [chained, setChained] = useState(false)
  // what the picture shows as on: whatever this screen didn't need to ask, and whatever was turned on here
  const [lit, setLit] = useState<PermissionKind[]>(() => screen.kinds.filter((x) => !screen.steps.some((s) => s.kind === x)))
  const [leaving, setLeaving] = useState(false)
  const step = screen.steps[k]
  const on = () => {
    setLit((l) => [...l, step.kind])
    if (k + 1 < screen.steps.length) { setK(k + 1); setChained(true); return }
    // a picture that shows what is on stays a moment, so the person sees it come alive
    if (screen.kinds.length > 1) { setLeaving(true); setTimeout(onNext, 700) } else onNext()
  }
  return <Ask key={step.kind} screen={screen} step={step} lit={lit} chained={chained} leaving={leaving} state={state} progress={progress} onOn={on} onLater={onNext} />
}

function Ask({ screen, step, lit, chained, leaving, state, progress, onOn, onLater }: {
  screen: OnboardingScreen; step: OnboardingStep; lit: PermissionKind[]; chained: boolean; leaving: boolean; state: SetupState; progress: Progress; onOn(): void; onLater(): void
}) {
  const { kind } = step
  const c = permissionCopy(kind)
  const sc = screenCopy(screen.id)
  const flow = usePermissionFlow(kind, step.status, onOn)
  // the second half of one Allow: the Mac's next prompt, right away
  useEffect(() => { if (chained && !viaSystemSettings(kind, step.status)) void flow.allow() }, [])
  const away = flow.phase === 'away'
  const back = flow.phase === 'back'
  const busy = flow.phase === 'asking' || leaving
  const primary = useRef<HTMLButtonElement>(null)
  useFocus(primary, [kind, flow.phase])
  const denied = flow.status === 'denied'
  const label = back ? t('Continue') : away || denied ? t('Open System Settings') : t('Allow')
  const note = away ? <GuideNote kind={kind} />
    : flow.phase === 'failed' ? <p data-testid="step-access-status" role="status" className="ob-note">{t("Couldn't check access. Try again.")}</p>
      : flow.phase === 'idle' && denied ? <p data-testid="step-access-status" role="status" className="ob-note">{t('This was turned off before, so only System Settings can turn it on. Yogurt shows you where.')}</p>
        : null
  // the picture changes only when there is a new thing to show: System Settings, or the screen's own drawing
  const art = away ? <SettingsArt kind={kind} /> : <ScreenArt id={screen.id} on={back ? [...lit, kind] : lit} />
  return (
    <Layout
      testId="onboarding-step" step={screen.id} kind={kind} motionKey={away ? `${screen.id}-away` : screen.id}
      art={art} progress={progress} state={state} note={note}
      title={away ? t('Turn on Yogurt in System Settings') : back ? t('All set') : sc.title}
      text={away ? c.where : back ? t('{name} is on. You can change this any time in Settings.', { name: c.name }) : sc.text}
      actions={<>
        <button ref={primary} data-testid="step-allow" aria-describedby="step-reason" disabled={busy}
          onClick={() => (back ? onOn() : away ? void flow.openSettings() : void flow.allow())} className="ob-button primary no-drag">
          {flow.phase === 'asking' && <LoaderCircle size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{label}
        </button>
        {!back && <button data-testid="step-later" disabled={busy} onClick={onLater} className="ob-button quiet no-drag">{t('Not now')}</button>}
      </>}
    />
  )
}

/** Under the buttons while System Settings is open: that Yogurt notices by itself, what to do if it isn't listed, and a reopen for the ones that need it */
function GuideNote({ kind }: { kind: PermissionKind }) {
  const [failed, setFailed] = useState(false)
  return (
    <div data-testid="settings-guide" className="ob-note">
      <p data-testid="settings-guide-waiting" role="status" className="ob-note-line">{t('Access is checked automatically.')}</p>
      <details key={kind} className="ob-guide-help">
        <summary>{t('Still not working?')}</summary>
        <div className="ob-guide-help-content">
        {(kind === 'accessibility' || kind === 'systemAudio') && <p>{t('Not in the list? Click +, then choose Yogurt in Applications.')}</p>}
        <p>{t('If you turned access on and this stays open, restart Yogurt.')}</p>
        <button data-testid="settings-guide-relaunch" className="ob-button secondary no-drag" onClick={() => {
          void window.yogurt.permissions.relaunch().then((ok) => setFailed(!ok), () => setFailed(true))
        }}>{t('Restart Yogurt')}</button>
      </div>
      </details>
      {failed && <p role="alert" className="ob-note-line ob-note-error">{t("Yogurt couldn't reopen. Quit it from the menu bar and open it again.")}</p>}
    </div>
  )
}

/** Speech setup: no choices to make. Home takes over when recording is ready; the notes model can arrive later. */
function Ready({ state }: { state: SetupState }) {
  const [shown, setShown] = useState(0)
  const pct = Math.floor(shown * 100 + 1e-8)
  const error = state.phase === 'error'
  const c = screenCopy('ready')
  return (
    <Layout
      testId="setup-ready" motionKey={error ? 'error' : 'ready'} art={<ReadyArt fraction={state.fraction} paused={error} onShown={setShown} />}
      title={error ? t("Couldn't finish setting up") : c.title} text={error ? state.message ?? '' : c.text} textTestId={error ? 'setup-error' : undefined}
      actions={error ? (
        <button data-testid="setup-retry" className="ob-button primary no-drag" onClick={() => void window.yogurt.setup.retry()}>{t('Try again')}</button>
      ) : (
        <div className="ob-progress">
          <div data-testid="setup-progress" role="progressbar" aria-label={transcriptionPhase(state)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="ob-progress-track">
            <div className="ob-progress-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <p role="status" data-testid="setup-percent" className="ob-progress-label tabular-nums">
            <span>{transcriptionPhase(state)}</span><span className="ob-progress-percent">{transcriptionPercent({ ...state, fraction: shown + Number.EPSILON })}</span>
          </p>
        </div>
      )}
    />
  )
}
