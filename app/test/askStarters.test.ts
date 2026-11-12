import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ConversationView } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())
function render(draft: string, panel = false) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const initial: ConversationView = { id: 'sample-chat', title: '', chips: [], draft, draftChips: [], firstChips: null, turns: [], waitsForMeeting: false, waitsForModel: false }
  return renderToStaticMarkup(createElement(AskConversation, { id: initial.id, initial, panel, home: !panel, onSelect() {}, onDeleted() {}, onSource() {} }))
}
it('keeps home starters in the layout but inaccessible while drafting, including mentions', () => {
  for (const draft of ['', 'W', '@']) {
    const html = render(draft), container = html.match(/<div data-testid="chat-starters"[^>]*>/)?.[0]
    expect(container).toBeTruthy()
    expect(html.match(/data-testid="chat-starter"/g)).toHaveLength(3)
    if (draft) {
      expect(container).toContain('aria-hidden="true"')
      expect(container).toContain('inert=""')
      expect(html.match(/data-testid="chat-starter" disabled=""/g)).toHaveLength(3)
    } else expect(container).not.toContain('aria-hidden')
  }
  const css = readFileSync(new URL('../src/renderer/src/workspace.css', import.meta.url), 'utf8')
  const hiddenRule = css.match(/\.ask-home-starters\[aria-hidden=true\] \{([^}]+)\}/)?.[1]
  expect(hiddenRule).toContain('visibility:hidden')
  expect(hiddenRule).not.toMatch(/display\s*:|height\s*:/)
})
it('preserves the note panel suggestion behavior', () => {
  expect(render('', true)).toContain('data-testid="chat-suggestions"')
  expect(render('@', true)).not.toContain('data-testid="chat-suggestions"')
})
