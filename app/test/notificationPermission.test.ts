import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings } from '../src/main/settings'

const native = vi.hoisted(() => ({ supported: true, requirement: '', reads: 0 }))
const notices: (EventEmitter & { show: ReturnType<typeof vi.fn> })[] = []
vi.mock('electron', () => ({ Notification: class extends EventEmitter {
  static isSupported() { return native.supported }
  show = vi.fn()
  constructor() { super(); notices.push(this) }
} }))
vi.mock('node:child_process', () => ({ execFile: (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
  native.reads++; cb(null, native.requirement, 'Executable=/build/Yogurt.app/Contents/MacOS/Yogurt\n')
} }))
const { createNotificationPermission, notificationIdentity } = await import('../src/main/notificationPermission')
const local = 'designated => identifier "so.yogurt.app" and certificate leaf = H"1111111111111111111111111111111111111111"'
const review = local.replace('so.yogurt.app', 'local.yogurt.native-review')
const otherSigner = local.replace(/1/g, '2')
const dirs: string[] = []
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-notification-test-')); dirs.push(dir)
  const path = join(dir, 'settings.json')
  native.requirement = `Executable=/build/Yogurt.app/Contents/MacOS/Yogurt\n${local}\n`
  return { path, permission: createNotificationPermission(path) }
}
afterEach(() => {
  vi.useRealTimers(); notices.length = 0; native.supported = true; native.reads = 0
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})

it('uses the bundle and signing requirement, excluding the install path', () => {
  expect(notificationIdentity(`Executable=/somewhere/Yogurt.app\n${local}\n`)).toBe(local)
  expect(notificationIdentity('code object is not signed at all')).toBeNull()
  expect(notificationIdentity('designated => identifier "so.yogurt.app"')).toBeNull()
})

it('ignores a migrated legacy flag and records only a confirmed post for this identity', async () => {
  const { path, permission } = rig()
  saveSettings(path, { notificationsAsked: true, notificationsAskedFor: [review], myName: 'Test' })
  expect(await permission.status()).toBe('unknown')
  const request = permission.request()
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  expect(notices[0].show).toHaveBeenCalledOnce()
  expect(await permission.status()).toBe('unknown')
  notices[0].emit('show')
  expect(await request).toBe('asked')
  expect(loadSettings(path)).toEqual({ notificationsAskedFor: [review, local], myName: 'Test' })
  expect(await permission.status()).toBe('asked')
  expect(await permission.request()).toBe('asked')
  expect(notices).toHaveLength(1)
  expect(native.reads).toBe(1)
  expect(await createNotificationPermission(path).status()).toBe('asked')
})

it('a different signer or bundle asks again, while ordinary rebuilds keep the record', async () => {
  const { path } = rig()
  saveSettings(path, { notificationsAskedFor: [local] })
  for (const identity of [review, otherSigner]) {
    native.requirement = identity
    expect(await createNotificationPermission(path).status()).toBe('unknown')
  }
  native.requirement = local
  expect(await createNotificationPermission(path).status()).toBe('asked')
})

it('failed and unsupported notifications remain retryable without saving an asked record', async () => {
  const { path, permission } = rig()
  native.supported = false
  expect(await permission.request()).toBe('unknown')
  expect(notices).toHaveLength(0)
  native.supported = true
  const request = permission.request()
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  notices[0].emit('failed', {}, 'Test failure')
  expect(await request).toBe('unknown')
  expect(loadSettings(path).notificationsAskedFor).toBeUndefined()
  const retry = permission.request()
  await vi.waitFor(() => expect(notices).toHaveLength(2))
  notices[1].emit('show')
  expect(await retry).toBe('asked')
})

it('an unreadable identity never inherits a profile flag or claims it registered', async () => {
  const { path, permission } = rig()
  saveSettings(path, { notificationsAsked: true, notificationsAskedFor: [local] })
  native.requirement = ''
  expect(await permission.status()).toBe('unknown')
  expect(await permission.request()).toBe('unknown')
  expect(notices).toHaveLength(0)
})

it('coalesces concurrent requests and times out without claiming a post', async () => {
  vi.useFakeTimers()
  const { path, permission } = rig()
  const a = permission.request(), b = permission.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(notices).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await a).toBe('unknown'); expect(await b).toBe('unknown')
  expect(loadSettings(path).notificationsAskedFor).toBeUndefined()
  expect(notices[0].listenerCount('show')).toBe(0)
})
