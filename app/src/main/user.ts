import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

let cached: string | undefined
/** The full name of the person using this Mac (Daniel Brooks), not the short one (daniel); cached */
export function macFullName(): string {
  if (cached !== undefined) return cached
  try { cached = execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim() } catch { cached = '' }
  return (cached ||= userInfo().username)
}
