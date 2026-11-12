import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { t } from '../../../shared/i18n'
import { useLoadingState } from '../useLoadingState'

/** A fading copy must not clear the live field's ref when it unmounts. */
export function loadingDecoration(children: ReactNode): ReactNode {
  return Children.map(children, child => {
    if (!isValidElement(child)) return child
    const element = child as ReactElement<{ children?: ReactNode; ref?: unknown; id?: string; 'data-testid'?: string }>
    return cloneElement(element, { ref: null, ...(typeof child.type === 'string' ? { id: undefined, 'data-testid': undefined } : {}) },
      element.props.children === undefined ? undefined : loadingDecoration(element.props.children))
  })
}

/** A shared layout can be its own skeleton; inert prevents placeholder controls receiving focus. */
export function LoadingContent({ pending, children, skeleton, testId, className = '', onReady }: {
  pending: boolean; children?: ReactNode; skeleton?: ReactNode; testId?: string; className?: string; onReady?: () => void
}) {
  const phase = useLoadingState(pending)
  const previous = useRef<ReactNode>(undefined)
  if (pending) previous.current = skeleton ?? loadingDecoration(children)
  const loading = phase === 'waiting' || phase === 'skeleton'
  const ready = useRef(onReady)
  ready.current = onReady
  useLayoutEffect(() => { if (!loading) ready.current?.() }, [loading])
  return <div className={`loading-content ${className}`} data-loading-phase={phase} aria-busy={loading}>
    {phase !== 'ready' && <div className="loading-placeholder" data-testid={testId}>
      {loading && <span className="sr-only" role="status">{t('Loading…')}</span>}
      <div className="loading-mask" aria-hidden="true" inert ref={el => {
        // Mirrored controls are decoration, never alternate label targets during the crossfade.
        if (skeleton === undefined) el?.querySelectorAll('[id],[data-testid]').forEach(node => { node.removeAttribute('id'); node.removeAttribute('data-testid') })
      }}>{previous.current}</div>
    </div>}
    {!pending && <div className="loading-result">{children}</div>}
  </div>
}
