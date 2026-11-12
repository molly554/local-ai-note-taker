import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/** Keep recovery beside the affected content, without hiding the content that was kept. */
export function InlineError({ testId, warningTestId, className = '', children }: {
  testId: string; warningTestId?: string; className?: string; children: ReactNode
}) {
  return <div data-testid={testId} data-state="failed" role="alert" className={`inline-error ${className}`}>
    <TriangleAlert data-testid={warningTestId} size={15} strokeWidth={1.75} aria-hidden="true" />
    {children}
  </div>
}
