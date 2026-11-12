import { createRecordingReminder } from '../src/main/recordingReminder'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadSettings, recordingReminderOn, updateSettings } from '../src/main/settings'

it('keeps the recording reminder on until explicitly turned off, and saves that choice', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'yogurt-reminder-')), 'settings.json')
  expect(recordingReminderOn(loadSettings(file))).toBe(true)
  updateSettings(file, { recordingReminder: false })
  expect(recordingReminderOn(loadSettings(file))).toBe(false)
  updateSettings(file, { recordingReminder: undefined })
  expect(recordingReminderOn(loadSettings(file))).toBe(true)
})

it('offers a new recording once even when views request it repeatedly', () => {
  const reminder = createRecordingReminder(() => true)
  reminder.started({ id: 'first' })
  expect(reminder.take()).toBe('first')
  expect(reminder.take()).toBeNull() // navigation or renderer reload
  reminder.started({ id: 'second' })
  expect(reminder.take()).toBe('second')
})

it('never offers a reminder on Resume, including after an app restart', () => {
  const reminder = createRecordingReminder(() => true)
  reminder.started({ id: 'existing', resume: { part: 1, startMs: 3000, startedAt: 0, capturedMs: 3000 } })
  expect(reminder.take()).toBeNull()
})

it('checks the setting at start and delivery without reminding retroactively', () => {
  let enabled = false
  const reminder = createRecordingReminder(() => enabled)
  reminder.started({ id: 'disabled' })
  enabled = true
  expect(reminder.take()).toBeNull()
  reminder.started({ id: 'enabled' })
  enabled = false
  expect(reminder.take()).toBeNull()
  enabled = true
  expect(reminder.take()).toBeNull()
  reminder.started({ id: 'next' })
  expect(reminder.take()).toBe('next')
})

it('drops an undelivered reminder when recording stops', () => {
  const reminder = createRecordingReminder(() => true)
  reminder.started({ id: 'short-call' })
  reminder.stopped()
  expect(reminder.take()).toBeNull()
})
