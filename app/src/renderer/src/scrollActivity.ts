/** Keep keyboard, wheel and programmatic scrolling visible after movement stops. */
export function installScrollActivity(root: Document) {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  const scroll = (event: Event) => {
    const el = event.target
    if (!(el instanceof HTMLElement)) return
    clearTimeout(timers.get(el))
    el.dataset.scrolling = ''
    timers.set(el, setTimeout(() => { delete el.dataset.scrolling; timers.delete(el) }, 1000))
  }
  root.addEventListener('scroll', scroll, { capture: true, passive: true })
  return () => {
    root.removeEventListener('scroll', scroll, { capture: true })
    for (const [el, timer] of timers) { clearTimeout(timer); delete el.dataset.scrolling }
    timers.clear()
  }
}
