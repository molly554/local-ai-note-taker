import { MARK, WORD } from '../../../shared/logo'

/** The Yogurt mark. */
export function Logo({ size = 28, className = 'text-accent' }: { size?: number; className?: string }) {
  return (
    <svg data-testid="logo" role="img" aria-label="Yogurt" width={size} height={size} viewBox="0 0 100 100" className={`shrink-0 ${className}`}>
      <path fill="currentColor" d={MARK} />
    </svg>
  )
}

/** The mark with the name next to it, as on the website. Sized by its height. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <svg data-testid="wordmark" role="img" aria-label="Yogurt" height={height} width={(height * 286) / 80} viewBox="0 0 286 80" className="shrink-0">
      <path className="text-accent" fill="currentColor" transform="translate(0 5) scale(.65)" d={MARK} />
      <path className="text-ink" fill="currentColor" transform="translate(82 55) scale(.068 -.068)" d={WORD} />
    </svg>
  )
}
