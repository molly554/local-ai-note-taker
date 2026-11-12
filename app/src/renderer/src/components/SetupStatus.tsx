import { Check, LoaderCircle, Lock } from 'lucide-react'
import type { SetupState } from '../../../shared/types'
import { language, t } from '../../../shared/i18n'
import { osWords } from '../keys'

/** One thing being set up in the background: done, or how far along. Add a line here for each new download. */
export type StatusItem = { id: string; done: boolean; text: string }
export const transcriptionPhase = (state: SetupState) => state.phase === 'downloading' && state.fraction < 1
  ? t('Downloading the transcription model') : t('Preparing the transcription model')
export const transcriptionPercent = (state: SetupState) => new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 0 }).format(Math.floor(Math.max(0, Math.min(1, state.fraction)) * 100) / 100)

export function setupItems(state: SetupState): StatusItem[] {
  // SetupState covers speech only; the notes model arrives later and is waited for where it is needed.
  return [{
    id: 'transcription', done: state.phase === 'ready',
    text: state.phase === 'ready' ? t('Transcription ready')
      : state.phase === 'downloading' ? `${transcriptionPhase(state)} · ${transcriptionPercent(state)}`
        : osWords({ mac: t('Everything stays on your Mac.'), other: t('Everything stays on your computer.') }),
  }]
}

/** The quiet line under the first run: the first thing still on its way, or that it's all ready */
export function SetupStatus({ state }: { state: SetupState }) {
  const items = setupItems(state)
  const busy = items.find((i) => !i.done)
  const shown = busy ?? items[items.length - 1]
  const Icon = !busy ? Check : state.phase === 'downloading' ? LoaderCircle : Lock
  return (
    <p data-testid="onboarding-setup-status" data-item={shown.id} className="setup-status">
      <Icon size={12} aria-hidden="true" className={Icon === LoaderCircle ? 'animate-spin motion-reduce:animate-none' : undefined} />
      <span>{shown.text}</span>
    </p>
  )
}
