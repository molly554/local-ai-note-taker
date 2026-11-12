import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskConversation } from '../src/renderer/src/components/AskConversation'
import type { ConversationTurn, ConversationView } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

it('keeps both composers busy through thinking and streaming, then releases on every terminal state', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const cases: [ConversationTurn['status'], string, boolean][] = [
    ['waiting', '', true], ['answering', '', true], ['answering', 'The first words', true],
    ['done', 'The answer', false], ['stopped', 'Partial answer', false], ['failed', '', false],
  ]
  for (const panel of [false, true]) for (const [status, answer, busy] of cases) {
    const initial: ConversationView = { id: 'composer-test', title: '', chips: [], draft: 'A follow-up', draftChips: [], firstChips: [],
      turns: [{ id: 1, question: 'What was decided?', status, answer, sources: [] }], waitsForMeeting: false, waitsForModel: false }
    const html = renderToStaticMarkup(createElement(AskConversation, { id: initial.id, initial, panel, onSelect() {}, onDeleted() {}, onSource() {} }))
    const form = html.match(/<form class="ask-box"[^>]*>/)?.[0]
    expect(form).toBeTruthy()
    expect(form!.includes('data-busy="true"')).toBe(busy)
    expect(form).not.toContain('data-thinking')
    expect(html).toContain('class="ask-border" aria-hidden="true"')
    expect(html).toContain('A follow-up')
  }
})

