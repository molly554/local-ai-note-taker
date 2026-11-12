import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Notification } from 'electron'
import { t } from '../shared/i18n'
import type { Access } from './permissions'
import { loadSettings, updateSettings } from './settings'

/** A designated requirement includes the bundle ID and signer, but no install path or build version. */
export function notificationIdentity(output: string): string | null {
  const requirement = output.match(/^designated => .+$/m)?.[0].trim()
  return requirement && /identifier "[^"]+"/.test(requirement) && /certificate |anchor |cdhash /.test(requirement) ? requirement : null
}

/** Remember a successful post for this signed app, never a migrated profile's unscoped flag. */
export function createNotificationPermission(settingsPath: string) {
  let identity: Promise<string | null> | undefined
  let pending: Promise<Access> | undefined
  const currentIdentity = () => identity ??= new Promise<string | null>((done) => {
    const bundle = resolve(dirname(process.execPath), '../..')
    execFile('/usr/bin/codesign', ['-d', '-r-', bundle], { timeout: 3000, maxBuffer: 16_384 }, (error, stdout) => {
      const key = error ? null : notificationIdentity(stdout)
      if (!key) console.warn('NOTIFICATIONS could not read app signing identity')
      done(key)
    })
  })
  const askedFor = () => {
    const keys = loadSettings(settingsPath).notificationsAskedFor
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []
  }
  const status = async (): Promise<Access> => {
    const key = await currentIdentity()
    return key && askedFor().includes(key) ? 'asked' : 'unknown'
  }
  const ask = async (): Promise<Access> => {
    const key = await currentIdentity()
    if (!key) return 'unknown'
    if (askedFor().includes(key)) return 'asked'
    if (!Notification.isSupported()) return 'unknown'
    return new Promise<Access>((done) => {
      const notice = new Notification({ title: 'Yogurt', body: t("You'll see a note here when a call starts."), silent: true })
      const finish = (access: Access) => {
        clearTimeout(timeout)
        notice.removeAllListeners()
        done(access)
      }
      const timeout = setTimeout(() => {
        console.warn('NOTIFICATIONS registration timed out; still unconfirmed')
        finish('unknown')
      }, 20_000)
      notice.once('show', () => {
        try {
          updateSettings(settingsPath, { notificationsAskedFor: [...new Set([...askedFor(), key])], notificationsAsked: undefined })
          console.info('NOTIFICATIONS registration posted for current signing identity')
          finish('asked')
        } catch (error) {
          console.warn('NOTIFICATIONS could not save registration', error)
          finish('unknown')
        }
      })
      notice.once('failed', (_event, error) => {
        console.warn('NOTIFICATIONS registration failed', error)
        finish('unknown')
      })
      try { notice.show() } catch (error) {
        console.warn('NOTIFICATIONS registration failed', error)
        finish('unknown')
      }
    })
  }
  return { status, request: () => pending ??= ask().finally(() => { pending = undefined }) }
}
