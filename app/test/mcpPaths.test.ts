import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helperCopyPath, installHelper, launchCommand, mcpAddress, startedHidden } from '../src/main/mcp/paths'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-mcp-paths-')); dirs.push(d); return d }

describe('where AI apps reach Yogurt', () => {
  it('is the socket in the profile folder on a Mac, as it always was', () => {
    expect(mcpAddress('darwin', '/Users/sam/Library/Application Support/Yogurt', 'ab12')).toBe('/Users/sam/Library/Application Support/Yogurt/mcp.sock')
  })
  it('is the socket in the profile folder on Linux', () => {
    expect(mcpAddress('linux', '/home/sam/.config/Yogurt', 'ab12')).toBe('/home/sam/.config/Yogurt/mcp.sock')
  })
  it('is a named pipe on Windows, named afresh each launch so no one else can take the name first', () => {
    expect(mcpAddress('win32', 'C:\\Users\\sam\\AppData\\Roaming\\Yogurt', 'ab12')).toBe('\\\\.\\pipe\\yogurt-mcp-ab12')
  })
})

describe('what the helper opens when Yogurt is closed', () => {
  it('is nothing to record on a Mac (it opens Yogurt by its bundle id)', () => {
    expect(launchCommand('darwin', true, '/Applications/Yogurt.app/Contents/MacOS/Yogurt', {})).toBeUndefined()
  })
  it('is the installed Yogurt.exe on Windows', () => {
    const exe = 'C:\\Users\\sam\\AppData\\Local\\Programs\\Yogurt\\Yogurt.exe'
    expect(launchCommand('win32', true, exe, {})).toBe(exe)
  })
  it('is the AppImage on Linux, wherever it was started from this time', () => {
    expect(launchCommand('linux', true, '/tmp/.mount_Yogurt1/yogurt', { APPIMAGE: '/home/sam/Apps/Yogurt.AppImage' })).toBe('/home/sam/Apps/Yogurt.AppImage')
    // not from an AppImage: the mount path would be gone next time
    expect(launchCommand('linux', true, '/opt/Yogurt/yogurt', {})).toBeUndefined()
  })
  it('is nothing for a dev or test run (that would start a bare Electron)', () => {
    expect(launchCommand('win32', false, 'C:\\dev\\electron.exe', {})).toBeUndefined()
    expect(launchCommand('linux', false, '/dev/electron', { APPIMAGE: '/x.AppImage' })).toBeUndefined()
  })
  it('starts without a window off a Mac when the helper asks, and never changes a Mac launch', () => {
    expect(startedHidden('win32', ['Yogurt.exe', '--hidden'])).toBe(true)
    expect(startedHidden('linux', ['yogurt', '--hidden'])).toBe(true)
    expect(startedHidden('linux', ['yogurt'])).toBe(false)
    expect(startedHidden('darwin', ['Yogurt', '--hidden'])).toBe(false)
  })
})

describe('the helper AI apps are told to start', () => {
  it('is copied into the profile folder on Linux only (the AppImage moves each launch)', () => {
    expect(helperCopyPath('linux', '/home/sam/.config/Yogurt')).toBe('/home/sam/.config/Yogurt/bin/yogurt-mcp')
    expect(helperCopyPath('darwin', '/x')).toBeUndefined()
    expect(helperCopyPath('win32', 'C:\\x')).toBeUndefined()
  })
  it('copies a new helper over the old one, runnable, and leaves an up to date one alone', () => {
    const dir = tmp()
    const src = join(dir, 'yogurt-mcp'), dest = join(dir, 'profile', 'bin', 'yogurt-mcp')
    writeFileSync(src, 'v1')
    expect(installHelper(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('v1')
    if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o755)
    expect(installHelper(src, dest)).toBe(false)
    writeFileSync(src, 'v2')
    expect(installHelper(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('v2')
  })
  it('gives up quietly when there is no helper to copy', () => {
    const dir = tmp()
    expect(installHelper(join(dir, 'missing'), join(dir, 'bin', 'yogurt-mcp'))).toBe(false)
  })
})
