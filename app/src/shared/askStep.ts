import { t } from './i18n'
import type { AskStep } from './types'

/** a step that runs long says it is still on it this often */
export const STEP_EVERY_MS = 4000

/**
 * What an answer that has not started says it is doing: the step main is on, and after each STEP_EVERY_MS (tick)
 * that it is still on it, staying on the last wording. No step yet: it waits in line or is about to start.
 */
export function stepText(step: AskStep | undefined, tick: number): string {
  const words = wordings(step)
  return words[Math.min(Math.max(0, tick), words.length - 1)]
}

function wordings(step: AskStep | undefined): string[] {
  if (!step || step.kind === 'loading') return [t('Thinking…'), t('Still thinking…')]
  if (step.kind === 'searching') return [t('Searching your meetings…'), t('Still searching your meetings…')]
  const next = t('Still reading. Your answer comes next.')
  if (step.title !== undefined || !step.meetings) {
    const title = step.title?.trim() || t('Untitled meeting')
    return [t('Reading {title}…', { title }), t('Still reading {title}…', { title }), next]
  }
  return [t('Reading {count} meetings…', { count: step.meetings }), t('Still reading {count} meetings…', { count: step.meetings }), next]
}
