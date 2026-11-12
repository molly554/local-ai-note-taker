import type { ReactElement } from 'react'
import { ScrollFade as Fade } from '@animate-ui/react/primitives/effects/scroll-fade'

/** Fade only overflowing edges of the existing scroller; no extra layout or moving text. */
export function ScrollFade({ children, enabled = true, size = 20 }: { children: ReactElement; enabled?: boolean; size?: number }) {
  return <Fade asChild enabled={enabled} size={size} shrink={0} blur={0} transition={{ duration: 0.16, ease: 'easeOut' }}>{children}</Fade>
}
