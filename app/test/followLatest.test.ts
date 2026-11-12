import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachFollowLatest } from '../src/renderer/src/followLatest'
import { followGlide } from '../src/renderer/src/motion'

vi.mock('../src/renderer/src/motion', () => ({ followGlide: vi.fn() }))
class Pane extends EventTarget {
  scrollHeight = 1200
  clientHeight = 400
  top = 0
  get scrollTop() { return this.top }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) }
}
class Resize {
  static current: Resize
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(public change: () => void) { Resize.current = this }
}
let doc: EventTarget & { hidden: boolean }
beforeEach(() => {
  doc = Object.assign(new EventTarget(), { hidden: false })
  vi.stubGlobal('document', doc); vi.stubGlobal('ResizeObserver', Resize)
  vi.mocked(followGlide).mockClear()
})
afterEach(() => vi.unstubAllGlobals())
function setup(initial = true) {
  const pane = new Pane(), body = new Pane(), state = { current: initial }, behind = vi.fn()
  const follow = attachFollowLatest(pane as unknown as HTMLElement, body as unknown as HTMLElement, state, behind)
  return { pane, state, behind, follow }
}
it('shares resize-driven following, the 24px threshold and reading-earlier preservation', () => {
  const { pane, state, behind, follow } = setup()
  expect(pane.scrollTop).toBe(800)
  expect(Resize.current.observe).toHaveBeenCalledTimes(2)
  pane.scrollHeight = 1400; Resize.current.change(); expect(pane.scrollTop).toBe(1000)
  pane.scrollTop = 976; pane.dispatchEvent(new Event('scroll')); expect(state.current).toBe(false)
  pane.scrollHeight = 1600; Resize.current.change(); expect(pane.scrollTop).toBe(976)
  expect(behind).toHaveBeenLastCalledWith(true)
  pane.scrollTop = 1177; pane.dispatchEvent(new Event('scroll')); expect(state.current).toBe(true)
  Resize.current.change(); expect(pane.scrollTop).toBe(1200)
  expect(followGlide).not.toHaveBeenCalled()
  follow.dispose()
})
it('wheeling up stops following at once, so a resize before the scroll lands cannot pull the pane back down', () => {
  const { pane, state, behind, follow } = setup()
  pane.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -400 })); expect(state.current).toBe(false)
  pane.scrollTop = 100; pane.scrollHeight = 1400; Resize.current.change(); expect(pane.scrollTop).toBe(100)
  expect(behind).toHaveBeenLastCalledWith(true)
  follow.dispose()
})
it('keeps a remembered reading position rather than jumping on attachment', () => {
  const { pane, follow } = setup(false)
  expect(pane.scrollTop).toBe(0)
  follow.dispose()
})
it('Latest reuses the finite glide, retargets arrivals and yields to user input', () => {
  let active = true
  const glide = { to: vi.fn(), stop: vi.fn(() => { active = false }), get active() { return active } }
  vi.mocked(followGlide).mockReturnValue(glide)
  const { pane, state, behind, follow } = setup(false)
  follow.latest(); expect(state.current).toBe(true); expect(behind).toHaveBeenLastCalledWith(false)
  expect(glide.to).toHaveBeenLastCalledWith(800)
  pane.scrollTop = 300; pane.dispatchEvent(new Event('scroll')); expect(state.current).toBe(true)
  pane.scrollHeight = 1400; Resize.current.change(); expect(glide.to).toHaveBeenLastCalledWith(1000)
  pane.dispatchEvent(new Event('wheel')); expect(glide.stop).toHaveBeenCalledOnce()
  pane.scrollTop = 150; pane.dispatchEvent(new Event('scroll'))
  pane.scrollHeight = 1600; Resize.current.change(); expect(pane.scrollTop).toBe(150)
  follow.dispose()
})
it('stops on hiding or completion cleanup, with no polling or work after disposal', () => {
  const glide = { to: vi.fn(), stop: vi.fn(), active: true }
  vi.mocked(followGlide).mockReturnValue(glide)
  const { pane, follow } = setup(false)
  follow.latest(); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'))
  expect(glide.stop).toHaveBeenCalledOnce()
  pane.scrollHeight = 1800; Resize.current.change(); expect(pane.scrollTop).toBe(0)
  follow.dispose(); expect(Resize.current.disconnect).toHaveBeenCalledOnce()
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); expect(pane.scrollTop).toBe(0)
})
it('does not move a collapsed pane', () => {
  const { pane, follow } = setup()
  pane.clientHeight = 0; pane.scrollHeight = 2000; Resize.current.change()
  expect(pane.scrollTop).toBe(800)
  follow.dispose()
})
it('keeps following when the body grows again before the scroll from the last follow lands', () => {
  const { pane, state, follow } = setup()
  pane.scrollHeight = 1400; Resize.current.change(); pane.scrollHeight = 2000
  pane.dispatchEvent(new Event('scroll')); expect(state.current).toBe(true)
  Resize.current.change(); expect(pane.scrollTop).toBe(1600)
  follow.dispose()
})
