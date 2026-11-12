import { commandKey, forOs, shortcutLabel, type OsWords } from '../../shared/platform'

// Use the native platform when the bridge is available.
const os = (): string => globalThis.window?.yogurt?.os ?? 'darwin'
/** Shortcuts are written the Mac's way in the code (⌘K); this shows them as this computer writes them (Ctrl+K off a Mac) */
export const keys = (mac: string): string => shortcutLabel(mac, os())
/** ⌘ held on a Mac, Ctrl on Windows and Linux */
export const command = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => commandKey(e, os())
export const onMac = (): boolean => os() === 'darwin'
/** A sentence in this computer's words: the Mac's, or Windows' and Linux's (the keys stay plain t() literals) */
export const osWords = (w: OsWords): string => forOs(w, os())
