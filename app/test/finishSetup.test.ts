import { afterEach, expect, it } from 'vitest'
import { FINISH_SETUP_KINDS, finishSetupPercent } from '../src/shared/onboarding'
import type { Access, PermissionStatus } from '../src/shared/types'
import { LOCALES, setLanguage } from '../src/shared/i18n'
import { finishSetupRemaining } from '../src/renderer/src/permissionCopy'
import { finishSetupReason } from '../src/renderer/src/permissionCopy'

const all = (a: Access): PermissionStatus => ({ mic: a, systemAudio: a, calendar: a, notifications: a, accessibility: a })
afterEach(() => setLanguage('en'))

it('counts completed applicable steps, ignoring Calendar and managed permissions', () => {
  expect(finishSetupPercent(all('unknown'))).toBe(0)
  expect(finishSetupPercent({ ...all('granted'), notifications: 'unknown', calendar: 'unknown' })).toBe(75)
  expect(finishSetupPercent({ ...all('granted'), mic: 'restricted', notifications: 'denied' })).toBe(67)
  expect(finishSetupPercent({ ...all('granted'), notifications: 'asked' })).toBe(100)
  expect(finishSetupPercent(all('restricted'))).toBe(100)
  expect(finishSetupPercent(all('denied'))).toBe(0)
})

it('keeps translated explanations concise and on one line', () => {
  for (const { id } of LOCALES) {
    setLanguage(id)
    for (const kind of FINISH_SETUP_KINDS) {
      const text = finishSetupReason(kind)
      // Copy-length guard; rendered checks measure the 340px card with each localized button.
      const length = [...new Intl.Segmenter(id, { granularity: 'grapheme' }).segment(text)].length
      expect(text, `${id}/${kind}`).not.toMatch(/[\n\r]/)
      expect(length, `${id}/${kind}: ${text}`).toBeLessThanOrEqual(/^(ja|ko|zh)/.test(id) ? 20 : 45)
    }
  }
})

it('labels the remaining work rather than repeating the ring percentage', () => {
  expect(finishSetupRemaining(1)).toBe('1 left')
  expect(finishSetupRemaining(2)).toBe('2 left')
  expect(finishSetupRemaining(4)).toBe('4 left')
})
