import type { ReactNode } from 'react'
import type { Mark } from '../../../shared/markdown'

/** Answers and source previews share inline formatting; links remain noninteractive text. */
export function InlineText({ marks = [], children }: { marks?: Mark[]; children: ReactNode }) {
  let text = children
  for (const mark of marks) {
    if (mark.type === 'bold') text = <strong>{text}</strong>
    else if (mark.type === 'italic') text = <em>{text}</em>
    else if (mark.type === 'code') text = <code>{text}</code>
  }
  return text
}
