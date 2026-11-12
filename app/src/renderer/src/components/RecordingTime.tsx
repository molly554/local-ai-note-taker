import { useEffect, useState } from 'react'
import type { WidgetView } from '../../../shared/types'
import { formatElapsed } from '../../../shared/wave'
import { t } from '../../../shared/i18n'

/** Main supplies recorded duration; the header only counts forward while that snapshot is running. */
export function RecordingTime({ view, testId = 'note-elapsed', className = 'note-elapsed' }: { view: WidgetView | null; testId?: string; className?: string }) {
  const [time, setTime] = useState('—')
  useEffect(() => {
    if (!view) { setTime('—'); return }
    const tick = () => setTime(formatElapsed(view.elapsedMs + (view.kind === 'recording' && !view.paused ? Math.max(0, Date.now() - view.at) : 0)))
    tick()
    if (view.kind !== 'recording' || view.paused) return
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [view])
  return <time data-testid={testId} className={className} aria-label={t('Recorded time')}>{time}</time>
}
