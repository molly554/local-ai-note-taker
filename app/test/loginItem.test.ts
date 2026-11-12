import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {} }))
import { autostartEntry, autostartFile, autostartOn, autostartPlan, pcLoginOnStart, WINDOWS_LOGIN } from '../src/main/loginItem'

it('Windows starts Yogurt at login with --hidden: in the tray, no window, like a Mac login launch', () => {
  expect(WINDOWS_LOGIN).toEqual({ args: ['--hidden'] })
  expect(pcLoginOnStart(true, false)).toBe('register')
  expect(pcLoginOnStart(false, true)).toBe('unregister')
  // turned off in Task Manager keeps the entry: theirs to decide
  for (const [w, on] of [[true, true], [false, false], [undefined, true], [undefined, false]] as const) expect(pcLoginOnStart(w, on)).toBe('none')
})

it('Linux: an XDG autostart entry that starts the AppImage hidden, quoted for any path', () => {
  expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/sam')).toBe('/cfg/autostart/yogurt.desktop')
  expect(autostartFile({}, '/home/sam')).toBe('/home/sam/.config/autostart/yogurt.desktop')
  const entry = autostartEntry('/home/sam/My Apps/Yogurt 100%.AppImage')
  expect(entry).toContain('[Desktop Entry]\nType=Application\nName=Lynote NoteTaker\n')
  expect(entry).toContain('Exec="/home/sam/My Apps/Yogurt 100%%.AppImage" --hidden\n')
  expect(autostartEntry('/a/$x"y.AppImage')).toContain('Exec="/a/\\\\$x\\\\"y.AppImage" --hidden\n')
})

it('Linux: puts a moved AppImage right, never brings back an entry the person removed', () => {
  const entry = autostartEntry('/new/Yogurt.AppImage')
  expect(autostartPlan(true, autostartEntry('/old/Yogurt.AppImage'), entry)).toBe('write')
  expect(autostartPlan(true, entry, entry)).toBe('none')
  expect(autostartPlan(true, null, entry)).toBe('none')
  expect(autostartPlan(false, entry, entry)).toBe('remove')
  expect(autostartPlan(false, null, entry)).toBe('none')
  expect(autostartPlan(true, `${entry}Hidden=true\n`, entry)).toBe('none')
  expect([autostartOn(entry), autostartOn(null), autostartOn(`${entry}Hidden=true\n`)]).toEqual([true, false, false])
})
