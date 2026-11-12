import { describe, expect, it } from 'vitest'
import { citationCardPassage, citationLineWindow } from '../src/shared/citationCard'
import { turns } from '../src/shared/transcript'
import { SPEAKER_COLORS } from '../src/shared/speakerColors'
import type { LibrarySource } from '../src/shared/types'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotesPassage } from '../src/renderer/src/components/SourceCitation'

const source: LibrarySource = { n: 1, meetingId: 'm', title: 'Standup', startedAt: 0, atMs: null }
const transcript: LibrarySource = { ...source, atMs: 0, excerpt: 'You: The review is done.\nJenny: We can move the handoff to tomorrow.\nThem: That gives everyone time to check the notes.', transcript: {
  speakers: ['Ann', 'Jenny'], lines: [
    { track: 'me', speaker: 'me', startMs: 0, text: 'The review is done.' },
    { track: 'them', speaker: 'Jenny', startMs: 1_887_000, text: 'We can move the handoff to tomorrow.' },
    { track: 'them', speaker: null, startMs: 1_895_000, text: 'That gives everyone time to check the notes.' },
  ],
} }

describe('citation card source treatment', () => {
  it('keeps notes bullets, inline formatting and the matched item wash', () => {
    const preview = citationCardPassage({ ...source, excerpt: '## Next steps\n- **You:** Send the plan.\n- **Jenny:** Book the room.\n- Review on Friday.' }, 'Jenny will book the room.')
    const html = renderToStaticMarkup(createElement(NotesPassage, { preview }))
    expect(html).toContain('<ul>')
    expect(html.match(/<li>/g)).toHaveLength(3)
    expect(html).toContain('<span class="citation-match"><strong>Jenny:</strong> Book the room.</span>')
    expect(html).not.toContain('Next steps')
  })
  it('retains list numbering and keeps sentences from one item in one list item', () => {
    const preview = citationCardPassage({ ...source, excerpt: '4. Check the draft.\n5. **Send** the plan. Include the budget.\n6. Meet on Friday.' }, 'Include the budget.')
    const html = renderToStaticMarkup(createElement(NotesPassage, { preview }))
    expect(html).toContain('<ol start="5">')
    expect(html.match(/<li value=/g)).toHaveLength(2)
    expect(html).toContain('<li value="5">')
    expect(html).toContain('<li value="6">')
    expect(html).toContain('<strong>Send</strong> the plan.')
    expect(html).toContain('<span class="citation-match">Include the budget.</span>')
  })
  it('renders notes with safe inline Markdown and the exact matched sentence', () => {
    const card = citationCardPassage({ ...source, excerpt: 'QA is Tuesday. **Publish** the *release notes* on `Wednesday`. Ann will share [the link](https://example.com).' }, 'Publish the release notes on Wednesday.')
    expect(card.kind).toBe('notes')
    expect(card.match.text).toBe('Publish the release notes on Wednesday.')
    expect(card.match.nodes.filter(n => n.marks?.length)).toEqual([
      { type: 'text', text: 'Publish', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'release notes', marks: [{ type: 'italic' }] },
      { type: 'text', text: 'Wednesday', marks: [{ type: 'code' }] },
    ])
    expect(card.before.text).toBe('QA is Tuesday.')
    expect(card.after.text).toBe('Ann will share the link.')
    expect(card.match.color).toBeUndefined()
  })
  it('uses the actual speaker and persisted note palette order, not citation order', () => {
    const card = citationCardPassage(transcript, 'Move the handoff to tomorrow.')
    expect(card.kind).toBe('transcript')
    expect(card.match).toMatchObject({ text: 'We can move the handoff to tomorrow.', track: 'them', speaker: 'Jenny', color: SPEAKER_COLORS[1], atMs: 1_887_000 })
    expect(card.before.track).toBe('me')
    expect(card.before.color).toBeUndefined()
    expect(card.after.speaker).toBeNull()
    expect(card.after.color).toBeUndefined()
  })
  it('treats timestamp zero as transcript and keeps You neutral and right-aligned', () => {
    const card = citationCardPassage(transcript, 'The review is done.')
    expect(card.kind).toBe('transcript')
    expect(card.match).toMatchObject({ track: 'me', atMs: 0 })
    expect(card.match.color).toBeUndefined()
  })
  it('keeps old or unverifiable speakers neutral, preserving ambiguous colon text', () => {
    const card = citationCardPassage({ ...source, atMs: 0, excerpt: 'Deadline: ship tomorrow.' }, 'Ship tomorrow.')
    expect(card.match).toMatchObject({ text: 'Deadline: ship tomorrow.', track: 'them' })
    expect(card.match.speaker).toBeUndefined()
    expect(card.match.color).toBeUndefined()
  })
  it('does not quote metadata outside the fitted retrieval excerpt', () => {
    const card = citationCardPassage({ ...transcript, excerpt: 'You: The review is done.' }, 'Handoff tomorrow.')
    expect(card.match.text).toBe('The review is done.')
    expect(card.after.text).toBe('')
  })
  it('omits missing passages instead of generating one from speaker metadata', () => {
    expect(citationCardPassage({ ...transcript, excerpt: undefined }, 'Tomorrow').match.text).toBe('')
  })
})


describe('transcript citation lines', () => {
  it('keeps one bubble per source line and shares the transcript speaker grouping', () => {
    const lines = [...transcript.transcript!.lines, { track: 'them' as const, speaker: null, startMs: 1_900_000, text: 'No rush.' }]
    const card = citationCardPassage({ ...transcript, excerpt: lines.map(l => l.text).join('\n'), transcript: { speakers: ['Jenny'], lines } }, 'Move the handoff to tomorrow.')
    expect(card.lines.map(l => l.text)).toEqual(lines.map(l => l.text))
    expect(card.matchedLine).toBe(1)
    expect(turns(card.lines).map(t => t.map(l => l.index))).toEqual([[0], [1], [2, 3]])
    expect(card.lines[1].color).toBe(SPEAKER_COLORS[0])
  })
  it('retains a fitted partial line without quoting the rest of its source segment', () => {
    const card = citationCardPassage({ ...transcript, excerpt: 'You: The review is done.\nJenny: We can move the handoff\n…' }, 'Move the handoff')
    expect(card.lines.map(l => l.text)).toEqual(['The review is done.', 'We can move the handoff…'])
    expect(card.matchedLine).toBe(1)
    expect(card.lines[1].speaker).toBe('Jenny')
  })
  it('keeps legacy excerpt lines anonymous without splitting sentences into bubbles', () => {
    const card = citationCardPassage({ ...source, atMs: 0, excerpt: 'The review is done. It went well.\nJenny: Handoff tomorrow.\nTime to check the notes.' }, 'Handoff tomorrow.')
    expect(card.lines).toHaveLength(3)
    expect(card.lines[0].text).toBe('The review is done. It went well.')
    expect(card.lines.every(l => l.speaker === null && l.color === undefined && l.track === 'them')).toBe(true)
    expect(card.lines[1].text).toBe('Jenny: Handoff tomorrow.')
  })
  it('trims whole outer lines, preserving the match and its nearest context', () => {
    expect(citationLineWindow([1, 2, 2, 2, 1], 2)).toEqual({ start: 1, end: 4 })
    expect(citationLineWindow([2, 8, 2], 1)).toEqual({ start: 1, end: 2 })
    expect(citationLineWindow([2, 2, 2], 1)).toEqual({ start: 0, end: 3 })
    expect(citationLineWindow([2, 2, 2, 2], 0)).toEqual({ start: 0, end: 3 })
  })
})
