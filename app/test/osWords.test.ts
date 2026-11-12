import { describe, expect, it } from 'vitest'
import { forOs } from '../src/shared/platform'
// @ts-expect-error plain JS script
import { i18nKeys } from '../scripts/i18n-keys.mjs'

const keys: string[] = i18nKeys()

describe('words for each computer', () => {
  const both = { mac: 'on your Mac', other: 'on your computer' }
  const each = { mac: 'in the menu bar', windows: 'in the notification area', linux: 'in the tray' }
  it('a Mac keeps its own words', () => {
    expect(forOs(both, 'darwin')).toBe('on your Mac')
    expect(forOs(each, 'darwin')).toBe('in the menu bar')
  })
  it('Windows and Linux share one sentence, or each get their own', () => {
    expect(forOs(both, 'win32')).toBe('on your computer')
    expect(forOs(both, 'linux')).toBe('on your computer')
    expect(forOs(each, 'win32')).toBe('in the notification area')
    expect(forOs(each, 'linux')).toBe('in the tray')
  })
})

describe('Mac text', () => {
  // every key that names the Mac, exactly as it was before Windows and Linux: each is shown only on a Mac,
  // or beside its own Windows and Linux sentence. A new one belongs here only if it is Mac only too.
  const MAC = [
    'Apps on this Mac can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.',
    'Connect the calendars on this Mac to see your upcoming meetings.',
    'Everything stays on your Mac.',
    'Its notes, transcript and recording are removed from this Mac for good.',
    'Make Yogurt feel at home on your Mac.',
    'Match my Mac',
    'No calendars found on this Mac.',
    "Notes start with the meeting's name and who's invited, from the calendars already on your Mac.",
    'Open Yogurt when your Mac starts',
    'Save every meeting, its notes, transcript and recording to one file. Use it to move to a new Mac or after reinstalling.',
    'Saved on this Mac',
    'This conversation is removed from this Mac for good. Your meetings stay as they are.',
    'Try reading the calendars on this Mac again.',
    'Uses the microphone your Mac is set to',
    "Yogurt hears you through your microphone, and everyone else through your Mac's sound.",
    'Yogurt is setting up transcription. This happens once, then it all runs on your Mac.',
    'Yogurt needs a Mac with at least 8 GB of memory.',
    'Yogurt writes your meeting notes while you talk. No bot joins the call, and nothing leaves your Mac.',
    "Your Mac's sound",
    'Your meetings, notes and audio stay on this Mac.',
    '{count} meetings, with their notes, transcripts and recordings, are removed from this Mac for good.',
  ]
  it('is unchanged, and nothing new names the Mac', () => {
    expect(keys.filter((k) => /\bMac\b/.test(k))).toEqual(MAC)
  })
  it('keeps the ⌘, menu bar, Finder and System Settings words', () => {
    for (const k of ['Ask Yogurt (⌘J)', 'Show Yogurt in the menu bar', 'Show in Finder', 'Open System Settings', 'Turn it on in System Settings'])
      expect(keys).toContain(k)
  })
  it('has a Windows and Linux sentence beside each one shown there', () => {
    for (const k of [
      'Everything stays on your computer.', 'Make Yogurt feel at home on your computer.', 'Saved on this computer',
      'Your meetings, notes and audio stay on this computer.', 'Apps on this computer can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.',
      'Match Windows', 'Match my system', 'Open Yogurt when Windows starts', 'Open Yogurt when you log in',
      'Show Yogurt in the notification area', 'Show Yogurt in the tray', 'Show in File Explorer', 'Show in Files',
    ]) expect(keys).toContain(k)
  })
})
