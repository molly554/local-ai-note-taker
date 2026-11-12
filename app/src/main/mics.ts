import { ipcMain } from 'electron'
import { activeCapture, onCaptureStart, type MicInUse } from './capture'
import type { Helper } from './calendar'
import { micsView, parseMicDevices } from './micDevice'
import { loadSettings, updateSettings } from './settings'

/** A mic's Core Audio UID from a page: text, short, no line breaks (it goes to the recorder as one stdin line) */
const isMicId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\r\n]/.test(x)

/**
 * The mic picker: which mics there are (yogurt-mac mic-devices), the one chosen (remembered in settings.json, null is Auto)
 * and, while recording, the one the recorder says it uses. Choosing one switches the meeting being recorded without stopping.
 */
export function hookMics(d: { helper: Helper; settingsFile: string; send: (channel: string, payload: unknown) => void }) {
  /** what the recorder of the meeting being recorded says it uses; null when nothing records */
  let live: MicInUse | null = null
  onCaptureStart((c) => {
    live = null
    c.on('mic', (m) => { if (activeCapture() === c) { live = m; d.send('audio:mics-changed', { fellBack: false }) } })
    c.on('warn', (code) => { if (code === 'mic-gone' && activeCapture() === c) d.send('audio:mics-changed', { fellBack: true }) })
    c.on('ended', () => { if (activeCapture() === c || !activeCapture()) live = null })
  })
  ipcMain.handle('audio:mics', async () => {
    let devices: ReturnType<typeof parseMicDevices> = []
    try { devices = parseMicDevices(await d.helper(['mic-devices'])) } catch (e) { console.warn("couldn't list the microphones", e) }
    return micsView(devices, loadSettings(d.settingsFile).mic, activeCapture() ? live : null)
  })
  ipcMain.handle('audio:set-mic', (_e, id: unknown) => {
    if (id !== null && !isMicId(id)) return false
    updateSettings(d.settingsFile, { mic: id ?? undefined })
    activeCapture()?.setMic(id)
    return true
  })
}
