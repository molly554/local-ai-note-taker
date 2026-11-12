import { afterEach, expect, it, vi } from 'vitest'
import { installScrollActivity } from '../src/renderer/src/scrollActivity'
class Element extends EventTarget { dataset: Record<string, string> = {} }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('shows each scrolling surface independently until one second after its last movement and cleans up', () => {
  vi.useFakeTimers(); vi.stubGlobal('HTMLElement', Element)
  const root = new EventTarget(), a = new Element(), b = new Element()
  const stop = installScrollActivity(root as Document)
  const scroll = (el: Element) => { const event = new Event('scroll'); Object.defineProperty(event, 'target', { value: el }); root.dispatchEvent(event) }
  scroll(a); vi.advanceTimersByTime(600); scroll(a); scroll(b)
  expect(a.dataset.scrolling).toBe('')
  vi.advanceTimersByTime(500)
  expect(a.dataset.scrolling).toBe('')
  vi.advanceTimersByTime(500)
  expect(a.dataset.scrolling).toBeUndefined(); expect(b.dataset.scrolling).toBeUndefined()
  scroll(a); stop(); expect(a.dataset.scrolling).toBeUndefined()
  scroll(b); expect(b.dataset.scrolling).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
