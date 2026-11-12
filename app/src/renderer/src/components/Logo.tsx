import { useId } from 'react'
import { PRODUCT } from '../../../shared/brand'
import { MARK } from '../../../shared/logo'

/** The mark alone, in one colour: a sheet of notes whose first line is a voice. */
export function Logo({ size = 28, className = 'text-accent' }: { size?: number; className?: string }) {
  return (
    <svg data-testid="logo" role="img" aria-label={PRODUCT} width={size} height={size} viewBox="0 0 100 100" className={`shrink-0 ${className}`}>
      <path fill="currentColor" d={MARK} />
    </svg>
  )
}

/** The app icon: the sheet in white on the violet-to-blue square, with the coral spark. The same numbers as build/icon.svg. */
export function AppIcon({ size = 28 }: { size?: number }) {
  const id = useId()
  return (
    <svg data-testid="app-icon" aria-hidden="true" width={size} height={size} viewBox="0 0 256 256" className="shrink-0">
      <defs>
        <linearGradient id={`${id}-square`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#AE7BFF" /><stop offset="1" stopColor="#5785FA" /></linearGradient>
        <linearGradient id={`${id}-spark`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FF8A7A" /><stop offset="1" stopColor="#FF9FB2" /></linearGradient>
      </defs>
      <rect width="256" height="256" rx="58" fill={`url(#${id}-square)`} />
      <rect x="60" y="48" width="136" height="160" rx="22" fill="#fff" />
      <g fill="#865EFF">
        <rect x="84" y="88" width="11" height="22" rx="5.5" /><rect x="103" y="76" width="11" height="46" rx="5.5" /><rect x="122" y="84" width="11" height="30" rx="5.5" />
        <rect x="141" y="72" width="11" height="54" rx="5.5" /><rect x="160" y="88" width="11" height="22" rx="5.5" />
      </g>
      <rect x="84" y="142" width="88" height="11" rx="5.5" fill="#C9B8FF" /><rect x="84" y="166" width="58" height="11" rx="5.5" fill="#C9B8FF" />
      <path transform="translate(176 178) scale(1.15)" fill={`url(#${id}-spark)`} d="M20 0c2.2 10.6 9.4 17.8 20 20-10.6 2.2-17.8 9.4-20 20C17.8 29.4 10.6 22.2 0 20 10.6 17.8 17.8 10.6 20 0z" />
    </svg>
  )
}

/** The icon with the name next to it. Sized by its height. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <span data-testid="wordmark" role="img" aria-label={PRODUCT} className="wordmark" style={{ height, fontSize: Math.round(height * 0.56) }}>
      <AppIcon size={height} />
      <span aria-hidden="true" className="wordmark-name">Lynote <span>NoteTaker</span></span>
    </span>
  )
}
