import { followGlide } from './motion'

/** Shared by growing answers and summaries; an idle or hidden pane schedules no work. */
export function attachFollowLatest(el: HTMLElement, body: HTMLElement, stuck: { current: boolean }, behind: (value: boolean) => void) {
  let glide: ReturnType<typeof followGlide> | undefined, last = el.scrollTop
  const stop = () => { glide?.stop(); glide = undefined }
  const report = () => behind(el.scrollHeight - el.scrollTop - el.clientHeight >= 24)
  const follow = () => {
    if (document.hidden || !el.clientHeight) return
    if (stuck.current) {
      if (glide?.active) glide.to(Math.max(0, el.scrollHeight - el.clientHeight))
      else { el.scrollTop = el.scrollHeight; last = el.scrollTop }
    }
    report()
  }
  // The scroll event lands a frame after we set scrollTop, by which time the body may have grown again,
  // so only a move up can stop following and only reaching the bottom can resume it.
  const scroll = () => {
    const up = el.scrollTop < last
    last = el.scrollTop
    if (glide?.active) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (up || near) stuck.current = near
    report()
  }
  const touch = () => { stop() }
  // Wheeling up is a decision to read: stop following before the next resize can pull the pane back down.
  const wheel = (event: Event) => { stop(); if ((event as WheelEvent).deltaY < 0) { stuck.current = false; report() } }
  const key = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stop()
  }
  const visibility = () => { if (document.hidden) stop(); else follow() }
  const observer = new ResizeObserver(follow)
  observer.observe(body); observer.observe(el)
  el.addEventListener('scroll', scroll, { passive: true })
  el.addEventListener('wheel', wheel, { passive: true })
  for (const event of ['touchstart', 'pointerdown']) el.addEventListener(event, touch, { passive: true })
  el.addEventListener('keydown', key)
  document.addEventListener('visibilitychange', visibility)
  follow()
  return {
    latest() {
      stuck.current = true; behind(false)
      if (document.hidden || !el.clientHeight) return
      stop()
      glide = followGlide(el, () => {})
      glide.to(Math.max(0, el.scrollHeight - el.clientHeight))
    },
    dispose() {
      stop(); observer.disconnect()
      el.removeEventListener('scroll', scroll)
      el.removeEventListener('wheel', wheel)
      for (const event of ['touchstart', 'pointerdown']) el.removeEventListener(event, touch)
      el.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', visibility)
    },
  }
}
