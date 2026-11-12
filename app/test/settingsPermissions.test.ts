import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionRow } from '../src/renderer/src/screens/Settings'
import type { Access, PermissionKind } from '../src/shared/types'

const row = (kind: PermissionKind, status: Access) => renderToStaticMarkup(createElement(PermissionRow, { kind, status, onAsk() {} }))
const action = (html: string) => html.match(/<button\b[\s\S]*?<\/button>/)?.[0] ?? ''

describe('permission action hierarchy', () => {
  it('offers a primary Turn on without a redundant badge for permissions it can request', () => {
    for (const kind of ['mic', 'systemAudio', 'calendar', 'notifications'] as const) {
      const html = row(kind, 'unknown')
      expect(html).not.toContain('Not set up')
      expect(action(html)).toContain('primary')
      expect(action(html)).toContain('permission-ask')
      expect(action(html)).toContain('Turn on')
    }
  })
  it('keeps denied recording/calendar actions prominent but routes to Settings', () => {
    for (const kind of ['mic', 'systemAudio', 'calendar'] as const) {
      expect(action(row(kind, 'denied'))).toContain('primary')
      expect(action(row(kind, 'denied'))).toContain('permission-open')
      expect(action(row(kind, 'denied'))).toContain('Turn on')
    }
  })
  it('opens Settings for Accessibility and previously requested notifications without claiming access', () => {
    for (const [kind, status] of [['accessibility', 'unknown'], ['accessibility', 'denied'], ['notifications', 'asked'], ['notifications', 'denied']] as const) {
      const html = row(kind, status)
      expect(action(html)).toContain('primary')
      expect(action(html)).toContain('permission-open')
      expect(action(html)).toContain('Open System Settings')
      expect(action(html)).not.toContain('permission-ask')
      expect(html).not.toContain('>On<')
    }
  })
  it('shows On plus a secondary Manage once access is granted', () => {
    for (const kind of ['mic', 'systemAudio', 'calendar', 'notifications', 'accessibility'] as const) {
      const html = row(kind, 'granted')
      expect(html).toContain('>On<')
      expect(action(html)).toContain('Manage')
      expect(action(html)).toContain('permission-open')
      expect(action(html)).not.toContain('primary')
    }
  })
  it('does not offer an action the organization prohibits', () => {
    expect(row('mic', 'restricted')).toContain('Managed by your organization')
    expect(action(row('mic', 'restricted'))).toBe('')
  })
})
