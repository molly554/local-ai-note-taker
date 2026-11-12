import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, posix } from 'node:path'

/** Windows: the pipe's name is in this file in the profile folder, where the helper reads it */
export const PIPE_FILE = 'mcp.pipe'
/** Windows and Linux: the program the helper starts when Yogurt is closed */
export const LAUNCH_FILE = 'mcp-launch'
/** what the helper passes when it starts Yogurt, so no window pops up in front of the AI app */
export const HIDDEN_ARG = '--hidden'

/**
 * Where AI apps reach Yogurt. Mac and Linux: a Unix socket in the profile folder, only for this person.
 * Windows: a named pipe. Its name is new each launch (id) and only written to the profile folder, so another
 * person on the same PC can't find it or take the name before Yogurt does.
 */
export function mcpAddress(platform: string, profile: string, id: string): string {
  return platform === 'win32' ? `\\\\.\\pipe\\yogurt-mcp-${id}` : posix.join(profile, 'mcp.sock')
}

/**
 * What the helper starts when Yogurt is closed. Windows: the installed Yogurt.exe. Linux: the AppImage, wherever
 * it was started from this time. A Mac opens Yogurt by its bundle id, and a dev or test run would start a bare Electron.
 */
export function launchCommand(platform: string, packaged: boolean, execPath: string, env: Record<string, string | undefined>): string | undefined {
  if (!packaged) return undefined
  if (platform === 'win32') return execPath
  if (platform === 'linux') return env.APPIMAGE || undefined
  return undefined
}

/** started by the helper off a Mac: no window, like opening at login. A Mac launch never changes */
export const startedHidden = (platform: string, argv: string[]): boolean => platform !== 'darwin' && argv.includes(HIDDEN_ARG)

/** Linux: the AppImage is mounted somewhere new each launch, so AI apps are given a copy in the profile folder */
export function helperCopyPath(platform: string, profile: string): string | undefined {
  return platform === 'linux' ? posix.join(profile, 'bin', 'yogurt-mcp') : undefined
}

/**
 * Puts the helper at dest when it isn't there already, in one step: an AI app may be running the old copy, and
 * writing over a running program fails. true: copied.
 */
export function installHelper(src: string, dest: string): boolean {
  if (!existsSync(src)) return false
  const bytes = readFileSync(src)
  if (existsSync(dest) && readFileSync(dest).equals(bytes)) return false
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.${process.pid}.part`
  copyFileSync(src, part)
  chmodSync(part, 0o755)
  renameSync(part, dest)
  return true
}
