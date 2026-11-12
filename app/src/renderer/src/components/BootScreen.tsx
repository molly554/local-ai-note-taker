import { useId } from 'react'
import { MARK } from '../../../shared/logo'
import { BOOT } from '../../../shared/onboarding'

/**
 * While Yogurt starts: the mark with a soft light passing over it. It fades in only after BOOT.showAfterMs from the
 * page's start (not from this mount), so a quick start never flashes it; App keeps it up for BOOT.minShownMs once seen.
 */
export function BootScreen() {
  const id = useId().replace(/:/g, '')
  const delay = Math.max(0, BOOT.showAfterMs - performance.now())
  return (
    <div data-testid="boot-screen" className="boot-screen" style={{ animationDelay: `${delay}ms` }} role="status" aria-label="Yogurt">
      <svg width={52} height={52} viewBox="0 0 100 100" aria-hidden="true" className="boot-mark">
        <defs>
          <clipPath id={`${id}-mark`}><path d={MARK} /></clipPath>
          <linearGradient id={`${id}-band`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${id}-mark)`}>
          <rect width="100" height="100" fill="currentColor" />
          <rect className="boot-band" x="-70" y="-10" width="60" height="120" fill={`url(#${id}-band)`} />
        </g>
      </svg>
    </div>
  )
}
