import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog'
import { useReducedMotion } from 'motion/react'
import { MotionPopup } from './MotionPopup'
import { surfaceMotion } from '../motion'

export const ModalClose = Dialog.Close

/** Shared accessible dialog with restrained motion and safe initial focus. */
export function Modal({ title, description, children, onCancel, busy = false, role = 'dialog', testId, fade = false, container }: {
  title: string; description?: string; children: ReactNode
  onCancel: () => void; busy?: boolean; role?: 'dialog' | 'alertdialog'; testId?: string
  fade?: boolean; container?: HTMLElement | null
}) {
  const [open, setOpen] = useState(true)
  const reduce = useReducedMotion()
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    if (open) return
    // Keep conditionally mounted callers alive until the primitive's exit finishes.
    const timer = setTimeout(() => cancel.current(), reduce ? 0 : fade ? 160 : surfaceMotion.exitHoldMs)
    return () => clearTimeout(timer)
  }, [open, reduce, fade])
  return <Dialog.Root open={open} onOpenChange={(next, event) => {
    if (!next && busy) { event.cancel(); return }
    setOpen(next)
  }}>
    <Dialog.Portal keepMounted container={container}>
      <Dialog.Backdrop className="app-modal-backdrop no-drag" transition={{ duration: reduce ? 0 : fade ? .16 : .2 }} exitTransition={{ duration: reduce ? 0 : surfaceMotion.exitMs / 1000 }} />
      <MotionPopup ref={dialog} open={open} reduced={!!reduce} fade={fade} data-testid={testId} role={role} aria-modal="true" aria-busy={busy || undefined}
        className="app-modal no-drag" finalFocus={opener} initialFocus={() => {
          const first = dialog.current?.querySelector<HTMLElement>('[data-dialog-focus], [data-dialog-cancel]')
          if (first instanceof HTMLInputElement) first.select()
          return first ?? dialog.current
        }}>
        <div className="modal-copy">
          <Dialog.Title>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
        </div>
        {children}
      </MotionPopup>
    </Dialog.Portal>
  </Dialog.Root>
}
