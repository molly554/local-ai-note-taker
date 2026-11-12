// a default import, so plain Node (local recording checks) can load this file too
import electron from 'electron'
import { join } from 'node:path'
import { PRODUCT } from '../shared/brand'

/** One profile folder however the app is started (dev, packaged), named after the app and so apart from Yogurt's own. YOGURT_USER_DATA uses a separate one (tests) */
export const userDataDir = (): string => process.env.YOGURT_USER_DATA ?? join(electron.app.getPath('appData'), PRODUCT)

/** Test mode: stand-ins for everything that needs a model, the microphone or a calendar */
export const isFake = (): boolean => process.env.YOGURT_FAKE === '1'
