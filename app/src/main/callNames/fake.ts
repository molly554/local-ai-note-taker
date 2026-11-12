import type { AxNode } from './parse'
import type { Watch } from './index'
import { fakeAccess } from '../fake'

/**
 * Fake mode: a Zoom call with Ann Lee, Bo Park and Cy Dao (not on the invite), Sam Rivera being "(me)". Ann is marked
 * talking for the e2e fixture's first line of the other side (5.2 s), Bo for its second (13.3 s). Without the fake
 * Accessibility permission (YOGURT_FAKE_AX), nothing can be read.
 */
export const fakeWatch = (): Watch => (_ids, onLine) => {
  const started = Date.now()
  const people = ['Sam Rivera', 'Ann Lee', 'Bo Park', 'Cy Dao']
  const timer = setInterval(() => {
    const t = Date.now()
    if (fakeAccess.accessibility !== 'granted') { onLine({ t, error: 'not-trusted' }); return }
    const at = t - started
    const talking = at >= 3000 && at < 11_000 ? 'Ann Lee' : at >= 11_000 && at < 24_000 ? 'Bo Park' : undefined
    const tiles = people.map((p): AxNode => ({ r: 'AXTabGroup', d: `${p}, Computer audio unmuted, Video off${p === talking ? ', Active speaker' : ''}` }))
    const list: AxNode = { r: 'AXOutline', d: 'Participants list', k: people.map((p) => ({ r: 'AXRow', k: [{ r: 'AXStaticText', v: p === 'Sam Rivera' ? `${p} (me)` : p }] })) }
    onLine({ t, app: 'us.zoom.xos', windows: [{ id: 'zm.meeting.window.main', title: 'Zoom Meeting', tree: { r: 'AXWindow', k: [...tiles, list] } }] })
  }, 250)
  return { stop: () => clearInterval(timer) }
}
