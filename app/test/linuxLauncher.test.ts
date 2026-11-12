import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { wrapLinuxBinary } from '../scripts/linux-launcher.cjs'

// The AppImage starts build/linux-launcher.sh under the program's name, which picks X11 before Electron starts (#8):
// an in-app relaunch couldn't mount the AppImage again on Wayland
function launch(env: Record<string, string>, args: string[] = []): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-launcher-'))
  writeFileSync(join(dir, 'lynote-notetaker'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n')
  chmodSync(join(dir, 'lynote-notetaker'), 0o755)
  wrapLinuxBinary(dir, 'lynote-notetaker')
  const out = execFileSync(join(dir, 'lynote-notetaker'), args, { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

it.skipIf(process.platform === 'win32')('on Wayland with XWayland it starts Electron on X11, keeping the arguments', () => {
  expect(launch({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, ['--hidden', 'a b'])).toEqual(['--ozone-platform=x11', '--hidden', 'a b'])
})

it.skipIf(process.platform === 'win32')('X11 alone, Wayland without XWayland, or a switch given by hand: Electron starts as asked', () => {
  expect(launch({ DISPLAY: ':0' }, ['--hidden'])).toEqual(['--hidden'])
  expect(launch({ WAYLAND_DISPLAY: 'wayland-0' })).toEqual([])
  expect(launch({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, ['--ozone-platform=wayland'])).toEqual(['--ozone-platform=wayland'])
})

it.skipIf(process.platform === 'win32')('wrapping twice keeps the real binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yogurt-launcher-'))
  copyFileSync('/bin/echo', join(dir, 'lynote-notetaker'))
  wrapLinuxBinary(dir, 'lynote-notetaker')
  expect(() => wrapLinuxBinary(dir, 'lynote-notetaker')).toThrow()
})
