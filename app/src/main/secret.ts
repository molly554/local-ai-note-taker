import { safeStorage } from 'electron'

/**
 * A secret kept in the settings file (the cloud model's key): sealed by the system's own store (the Mac's Keychain,
 * Windows' data protection, the Linux keyring), so the file never holds it in plain text. null: the system has no
 * such store here, and the secret is not kept.
 */
export const seal = (plain: string): string | null => {
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null } catch { return null }
}
export const open = (kept: string): string | null => {
  try { return safeStorage.decryptString(Buffer.from(kept, 'base64')) } catch { return null }
}
