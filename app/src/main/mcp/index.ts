import { app, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { helperFile } from '../../shared/platform'
import type { Store } from '../store'
import { createMcp } from './server'
import { helperCopyPath, installHelper, LAUNCH_FILE, launchCommand, mcpAddress, PIPE_FILE } from './paths'
import { serveMcp } from './socket'

/** yogurt-mcp, the program an AI app starts: it passes messages between that app and Yogurt */
export function mcpHelperPath(): string {
  const file = helperFile('mcp', process.platform)
  const candidates = [
    process.resourcesPath && join(process.resourcesPath, 'bin', file),
    join(__dirname, '../../resources/bin', file),
  ].filter((x): x is string => !!x)
  return candidates.find((c) => existsSync(c)) ?? candidates.at(-1)!
}

/** small files the helper reads, written whole so it never reads half of one */
function writeWhole(path: string, text: string) {
  writeFileSync(`${path}.part`, text)
  renameSync(`${path}.part`, path)
}

/** Linux: AI apps are given a copy in the profile folder, because the AppImage's own path moves each launch */
function copyHelper(profile: string): string | undefined {
  const dest = helperCopyPath(process.platform, profile)
  if (!dest) return undefined
  try { installHelper(mcpHelperPath(), dest) } catch (e) { console.error('mcp: could not copy the helper to the profile folder', e) }
  return existsSync(dest) ? dest : undefined
}

/**
 * MCP for AI apps on this Mac, behind Settings (off until turned on). The socket is always there, so an app that
 * connects while it's off is told where to turn it on instead of failing without a word.
 */
export async function hookMcp(d: {
  /** the profile folder: the socket (Mac, Linux) or the pipe's name (Windows) is there, for the helper */
  store: Store; profile: string; enabled: () => boolean; setEnabled: (on: boolean) => void; me: () => string; version: string
  audio: (id: string) => Promise<Array<{ track: 'me' | 'them'; path: string }>>
  /** Settings is told when apps come and go */
  send: (clients: string[]) => void
}) {
  const mcp = createMcp({ store: d.store, enabled: d.enabled, me: d.me, version: d.version, audio: d.audio, platform: process.platform })
  let server: Awaited<ReturnType<typeof serveMcp>> | undefined
  const address = mcpAddress(process.platform, d.profile, randomBytes(16).toString('hex'))
  try {
    server = await serveMcp(address, mcp, d.send)
    if (process.platform === 'win32') writeWhole(join(d.profile, PIPE_FILE), address)
  } catch (e) { console.error('mcp: could not open its socket', e) }
  // what the helper starts when Yogurt is closed (Windows, Linux): recorded each launch, as an AppImage can move
  const launch = launchCommand(process.platform, app.isPackaged, process.execPath, process.env)
  if (launch) { try { writeWhole(join(d.profile, LAUNCH_FILE), launch) } catch (e) { console.error('mcp: could not record how to open Yogurt', e) } }
  const copy = copyHelper(d.profile)
  const status = () => ({ enabled: d.enabled(), clients: server?.clients() ?? [], command: copy ?? mcpHelperPath() })
  ipcMain.handle('mcp:status', status)
  ipcMain.handle('mcp:set', (_e, on: unknown) => { d.setEnabled(on === true); return status() })
  return { close: () => server?.close() }
}
