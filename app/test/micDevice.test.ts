import { describe, expect, it } from 'vitest'
import { micsView, micToUse, parseMicDevices } from '../src/main/micDevice'

const mac = { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', isDefault: false }
const yeti = { id: 'usb:yeti', name: 'Yeti Stereo Microphone', isDefault: true }

describe('the microphones yogurt-mac lists', () => {
  it('reads each mic with its id, name and whether the Mac uses it now', () => {
    expect(parseMicDevices({ devices: [
      { uid: 'usb:yeti', name: 'Yeti Stereo Microphone', default: true },
      { uid: 'BuiltInMicrophoneDevice', name: ' MacBook Pro Microphone ', default: false },
    ] })).toEqual([yeti, mac])
  })
  it('drops what it cannot read, and a mic listed twice', () => {
    expect(parseMicDevices({ devices: [
      { uid: '', name: 'No id' }, { uid: 'x', name: '  ' }, { uid: 42, name: 'Bad id' }, null, 'mic',
      { uid: 'usb:yeti', name: 'Yeti Stereo Microphone', default: true }, { uid: 'usb:yeti', name: 'Yeti again', default: false },
    ] })).toEqual([yeti])
    expect(parseMicDevices({ devices: 'nope' })).toEqual([])
    expect(parseMicDevices(null)).toEqual([])
    expect(parseMicDevices({})).toEqual([])
  })
})

describe('which mic a recording uses', () => {
  it('the remembered one when it is here, else Auto', () => {
    expect(micToUse('usb:yeti', [mac, yeti])).toBe('usb:yeti')
    expect(micToUse('usb:gone', [mac, yeti])).toBeNull()
    expect(micToUse(null, [mac, yeti])).toBeNull()
    expect(micToUse(undefined, [])).toBeNull()
  })
})

describe('what the picker shows', () => {
  it('before recording: the remembered mic, else Auto with the default mic name', () => {
    expect(micsView([mac, yeti], 'BuiltInMicrophoneDevice', null)).toEqual({ devices: [mac, yeti], choice: 'BuiltInMicrophoneDevice', using: 'MacBook Pro Microphone', defaultName: 'Yeti Stereo Microphone' })
    expect(micsView([mac, yeti], 'usb:gone', null)).toMatchObject({ choice: null, using: 'Yeti Stereo Microphone' })
    expect(micsView([mac, yeti], null, null)).toMatchObject({ choice: null, using: 'Yeti Stereo Microphone' })
  })
  it('while recording: what the recorder says it uses', () => {
    expect(micsView([mac, yeti], 'usb:yeti', { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' })).toMatchObject({ choice: 'BuiltInMicrophoneDevice', using: 'MacBook Pro Microphone' })
    // Auto: the default's name as the recorder reported it
    expect(micsView([mac, yeti], 'usb:yeti', { uid: null, name: 'Yeti Stereo Microphone' })).toMatchObject({ choice: null, using: 'Yeti Stereo Microphone' })
    // a mic the list no longer has is not checked
    expect(micsView([yeti], null, { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' })).toMatchObject({ choice: null })
  })
  it('no mics at all', () => {
    expect(micsView([], null, null)).toEqual({ devices: [], choice: null, using: null, defaultName: null })
  })
})
