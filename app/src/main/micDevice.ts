import type { MicDevice, MicsView } from '../shared/types'

/** yogurt-mac mic-devices says {"devices":[{"uid","name","default"}]}: every microphone, and the one the Mac uses now */
export function parseMicDevices(raw: unknown): MicDevice[] {
  const list = raw && typeof raw === 'object' ? (raw as { devices?: unknown }).devices : null
  if (!Array.isArray(list)) return []
  const out: MicDevice[] = []
  for (const d of list) {
    if (!d || typeof d !== 'object') continue
    const { uid, name, default: isDefault } = d as Record<string, unknown>
    if (typeof uid !== 'string' || !uid || typeof name !== 'string' || !name.trim() || out.some((m) => m.id === uid)) continue
    out.push({ id: uid, name: name.trim(), isDefault: isDefault === true })
  }
  return out
}

/** The mic a recording starts with: the remembered one when it is here today, else Auto (null) */
export const micToUse = (saved: string | null | undefined, devices: MicDevice[]): string | null =>
  saved && devices.some((d) => d.id === saved) ? saved : null

/**
 * What the picker shows. While recording, what the recorder said it uses (live); before, the remembered mic.
 * using: the name on the pill, the default's for Auto.
 */
export function micsView(devices: MicDevice[], saved: string | null | undefined, live: { uid: string | null; name: string | null } | null): MicsView {
  const defaultName = devices.find((d) => d.isDefault)?.name ?? null
  const choice = micToUse(live ? live.uid : saved, devices)
  const using = live ? live.name ?? defaultName : choice ? devices.find((d) => d.id === choice)!.name : defaultName
  return { devices, choice, using, defaultName }
}
