import { Dialog } from '@base-ui/react/dialog'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react'
import { surfaceMotion } from '../motion'

/** Base UI keeps focus, dismissal and title semantics; only the decorative shell stretches. */
export const MotionPopup = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Dialog.Popup> & { open: boolean; reduced: boolean; fade?: boolean }>(
  function MotionPopup({ open, reduced, fade = false, children, className, ...props }, ref) {
    const popup = useRef<HTMLDivElement>(null)
    const surface = useRef<HTMLDivElement>(null)
    const contents = useRef<HTMLDivElement>(null)
    const animations = useRef<Animation[]>([])
    useImperativeHandle(ref, () => popup.current!, [])
    useLayoutEffect(() => {
      const el = popup.current, shell = surface.current, body = contents.current
      if (!el || !shell || !body) return
      const running = animations.current.some(animation => animation.playState === 'running')
      const shape = getComputedStyle(shell), text = getComputedStyle(body)
      const transform = shape.transform, opacity = shape.opacity, textOpacity = text.opacity, clip = text.clipPath
      const popupOpacity = getComputedStyle(el).opacity
      animations.current.forEach(animation => animation.cancel())
      animations.current = []
      if (reduced) return
      if (fade) {
        animations.current = [el.animate([{ opacity: running ? popupOpacity : open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration: 160, easing: 'ease-out', fill: 'both' })]
        return
      }
      const duration = open ? surfaceMotion.settleMs : surfaceMotion.exitMs
      const frames: Keyframe[] = open ? [
        { transform: running ? transform : 'translateY(12px) scale(.94, .86)', opacity: running ? opacity : 0, easing: surfaceMotion.settleEase },
        { transform: 'translateY(-1px) scale(1.008, 1.018)', opacity: 1, offset: surfaceMotion.settleAt, easing: 'ease-out' },
        { transform: 'none', opacity: 1 },
      ] : [
        { transform: running ? transform : 'none', opacity: running ? opacity : 1 },
        { transform: 'translateY(6px) scale(.98, .96)', opacity: 0 },
      ]
      // The content stays at its final size, cropped to the stretching surface so it never shows past the surface's edge.
      const box = body.getBoundingClientRect(), round = getComputedStyle(el).borderRadius
      const cropped = (y: number, sx: number, sy: number) => {
        const side = (1 - sx) / 2 * box.width, edge = (1 - sy) / 2 * box.height
        return `inset(${edge + y}px ${side}px ${edge - y}px ${side}px round ${round})`
      }
      const crops: Keyframe[] = open ? [
        { clipPath: running && clip !== 'none' ? clip : cropped(12, .94, .86), easing: surfaceMotion.settleEase },
        { clipPath: cropped(-1, 1.008, 1.018), offset: surfaceMotion.settleAt, easing: 'ease-out' },
        { clipPath: cropped(0, 1, 1) },
      ] : [
        { clipPath: running && clip !== 'none' ? clip : cropped(0, 1, 1) },
        { clipPath: cropped(6, .98, .96) },
      ]
      animations.current = [
        shell.animate(frames, { duration, easing: open ? 'linear' : 'ease-out', fill: 'both' }),
        body.animate(crops, { duration, easing: open ? 'linear' : 'ease-out', fill: open ? 'backwards' : 'forwards' }),
        body.animate([{ opacity: running ? textOpacity : open ? 0 : 1 }, { opacity: open ? 1 : 0 }], {
          duration: open ? 150 : 90, delay: open ? 35 : 0, easing: 'ease-out', fill: 'both',
        }),
        // Base UI observes animations on the popup itself before completing its exit.
        el.animate([{ opacity: 1 }, { opacity: 1 }], { duration, fill: 'both' }),
      ]
    }, [open, reduced, fade])
    useEffect(() => () => animations.current.forEach(animation => animation.cancel()), [])
    return <Dialog.Popup {...props} ref={popup} className={state => `${typeof className === 'function' ? className(state) : className ?? ''} dialog-motion`}>
      <div ref={surface} className="dialog-motion-surface" aria-hidden="true" />
      <div ref={contents} className="dialog-motion-content">{children}</div>
    </Dialog.Popup>
  },
)
