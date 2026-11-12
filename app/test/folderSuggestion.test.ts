import { describe, expect, it } from 'vitest'
import { folderSuggestionPrompt, parseFolderSuggestion, shouldSuggestFolder } from '../src/shared/folderSuggestion'

const folders = [{ id: 'a', name: 'Customers', examples: ['Fourth', 'Third', 'Second', 'First', 'Too old'] }]
describe('folder suggestion', () => {
  it('includes four newest examples and bounds the meeting details', () => {
    const prompt = folderSuggestionPrompt(folders, { title: 'Kickoff', attendees: [{ name: 'Alex' }], summary: 'x'.repeat(3000) })
    expect(prompt).toContain('Fourth')
    expect(prompt).toContain('First')
    expect(prompt).not.toContain('Too old')
    expect(prompt).toContain('Alex')
    expect(prompt).not.toContain('x'.repeat(1601))
  })
  it('requires an exact, unambiguous name and numeric confidence at least 0.8', () => {
    expect(parseFolderSuggestion('{"folder":"Customers","confidence":0.8}', folders)).toEqual({ folderId: 'a', confidence: 0.8 })
    for (const raw of ['junk', '```json\n{}\n```', '{"folder":"customers","confidence":1}', '{"folder":null,"confidence":1}', '{"folder":"Customers","confidence":0.79}', '{"folder":"Customers","confidence":"1"}', '{"folder":"Customers","confidence":2}', '{"folder":"Customers","confidence":1,"extra":true}']) expect(parseFolderSuggestion(raw, folders).folderId).toBeNull()
    expect(parseFolderSuggestion('{"folder":"Customers","confidence":1}', [...folders, { ...folders[0], id: 'b' }]).folderId).toBeNull()
  })
  it('only retries an unsuccessful attempt when the folder set changes', () => {
    const input = { hasFolders: true, filed: false, trashed: false, summary: true, recording: false, state: null, attempted: null, fingerprint: 'v1' } as const
    expect(shouldSuggestFolder(input)).toBe(true)
    for (const patch of [{ hasFolders: false }, { filed: true }, { trashed: true }, { summary: false }, { recording: true }, { state: 'pending' }, { state: 'accepted' }, { state: 'dismissed' }, { attempted: 'v1' }]) expect(shouldSuggestFolder({ ...input, ...patch })).toBe(false)
    expect(shouldSuggestFolder({ ...input, attempted: 'v0' })).toBe(true)
  })
})
