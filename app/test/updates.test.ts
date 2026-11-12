import { expect, it } from 'vitest'
import { isPreviewBuild, updatesOn } from '../src/main/updates'

const installed = { packaged: true, fake: false, profile: false, feed: true }

it('an installed Yogurt looks for new versions', () => {
  expect(updatesOn(installed)).toBe(true)
})

it('never while developing, testing, or on a separate profile', () => {
  expect(updatesOn({ ...installed, packaged: false })).toBe(false)
  expect(updatesOn({ ...installed, fake: true })).toBe(false)
  expect(updatesOn({ ...installed, profile: true })).toBe(false)
})

it('a local signed install without app-update.yml never starts the updater', () => {
  expect(updatesOn({ ...installed, feed: false })).toBe(false)
})

it('on Linux only the AppImage can replace itself; Windows uses the installer feed', () => {
  expect(updatesOn({ ...installed, platform: 'linux', appImage: false })).toBe(false)
  expect(updatesOn({ ...installed, platform: 'linux', appImage: true })).toBe(true)
  expect(updatesOn({ ...installed, platform: 'win32', appImage: false })).toBe(true)
  expect(updatesOn({ ...installed, platform: 'darwin', appImage: false })).toBe(true)
})

it('a preview build (unsigned, never released) never looks for new versions, on any computer', () => {
  for (const platform of ['win32', 'linux', 'darwin']) expect(updatesOn({ ...installed, platform, appImage: true, preview: true })).toBe(false)
  expect(updatesOn({ ...installed, preview: false })).toBe(true)
})

it('a preview build is told by its package.json; a release build or anything unreadable is not one', () => {
  expect(isPreviewBuild(JSON.stringify({ name: 'yogurt', yogurtPreview: true }))).toBe(true)
  expect(isPreviewBuild(JSON.stringify({ name: 'yogurt' }))).toBe(false)
  expect(isPreviewBuild('')).toBe(false)
})
