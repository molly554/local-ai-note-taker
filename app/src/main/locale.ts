import { app } from 'electron'
import { matchLocale } from '../shared/i18n'

/** The computer's language, among Yogurt's. YOGURT_SYSTEM_LANGUAGES stands in for the computer's list (tests) */
export const systemLocale = () => matchLocale(process.env.YOGURT_SYSTEM_LANGUAGES?.split(',') ?? app.getPreferredSystemLanguages())
