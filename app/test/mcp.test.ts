import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { createMcp, MCP_TOOLS, type Mcp } from '../src/main/mcp/server'
import { serveMcp } from '../src/main/mcp/socket'
import { mcpAddress } from '../src/main/mcp/paths'
import { randomBytes } from 'node:crypto'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'yogurt-mcp-')); dirs.push(d); return d }

function setup(o: { enabled?: boolean; platform?: string } = {}) {
  const dir = tmp()
  const store = openStore(join(dir, 'yogurt.db')); stores.push(store)
  const base = { endedAt: null, eventId: null, app: 'Zoom', state: 'done' as const }
  const older = store.createMeeting({ ...base, title: 'Budget review', startedAt: Date.parse('2026-11-01T17:00:00Z'), endedAt: Date.parse('2026-11-01T17:25:00Z'), attendees: [{ name: 'Ann Lee', email: 'ann@acme.com' }] })
  const newer = store.createMeeting({ ...base, title: 'Launch plan', startedAt: Date.parse('2026-11-02T16:00:00Z'), attendees: [] })
  store.addSegments([
    { meetingId: older.id, track: 'me', startMs: 5_000, endMs: 7_000, text: 'Can we keep travel flat?', speaker: 'me' },
    { meetingId: older.id, track: 'them', startMs: 65_000, endMs: 68_000, text: 'Travel spend is down a little.', speaker: 'Ann Lee' },
    { meetingId: older.id, track: 'them', startMs: 70_000, endMs: 71_000, text: 'Sure.', speaker: null },
    { meetingId: older.id, track: 'me', startMs: 72_000, endMs: 73_000, text: 'an echo', speaker: 'me', hidden: true },
  ])
  store.setNotes(older.id, { mine: 'travel flat', enhanced: '## Budget\n- Travel stays flat.' })
  const audioDir = join(dir, 'meetings', older.id); mkdirSync(audioDir, { recursive: true })
  writeFileSync(join(audioDir, 'me.m4a'), 'x'); writeFileSync(join(audioDir, 'them.m4a'), 'x')
  let on = o.enabled ?? true
  const clients: string[] = []
  const mcp = createMcp({
    store, enabled: () => on, me: () => 'Sam Rivera', version: '0.1.0', platform: o.platform,
    audio: async (id) => id === older.id ? [{ track: 'me', path: join(audioDir, 'me.m4a') }, { track: 'them', path: join(audioDir, 'them.m4a') }] : [],
  })
  return { store, mcp, older, newer, dir, clients, turn: (v: boolean) => { on = v } }
}

const call = async (mcp: Mcp, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  return { text: r.result.content.map((c) => c.text).join('\n'), isError: !!r.result.isError }
}
const json = async (mcp: Mcp, name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(mcp, name, args)).text)

describe('the MCP server', () => {
  it('says who it is and that it has tools, in the protocol version the app asked for when it knows it', async () => {
    const { mcp } = setup()
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } })
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'yogurt', version: '0.1.0' } } })
    const odd = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }) as { result: { protocolVersion: string } }
    expect(odd.result.protocolVersion).toBe('2025-06-18')
  })
  it('lists its tools, all of them only reading', async () => {
    const { mcp } = setup()
    const r = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } }
    expect(r.result.tools.map((t) => t.name)).toEqual(['list_meetings', 'get_meeting', 'get_transcript', 'search', 'get_audio'])
    expect(r.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true)
    expect(MCP_TOOLS).toHaveLength(5)
  })
  it("tells other apps' models about the Mac on a Mac, and about Ogg files on Windows and Linux", async () => {
    const audioText = async (platform?: string) => {
      const { mcp } = setup({ platform })
      const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { result: { instructions: string } }
      const list = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: Array<{ name: string; description: string }> } }
      return [init.result.instructions, list.result.tools.find((t) => t.name === 'get_audio')!.description]
    }
    const mac = "A meeting's recording as files on this Mac: one per side (track me: the person's microphone; them: the other side of the call), AAC in .m4a. Gives paths, which apps on this Mac can open."
    expect(await audioText()).toEqual(["Lynote NoteTaker holds the person's meeting notes, transcripts and recordings on this Mac. Use list_meetings or search to find a meeting, then get_meeting, get_transcript or get_audio.", mac])
    expect(await audioText('darwin')).toEqual(await audioText())
    for (const p of ['win32', 'linux']) {
      const [instructions, audio] = await audioText(p)
      expect(instructions).toContain('on this computer.')
      expect(audio).toContain('Ogg Opus in .ogg')
      expect(`${instructions} ${audio}`).not.toMatch(/this Mac/)
    }
  }, 30_000) // five databases: under a second on a Mac, over 5 s on GitHub's Windows runners
  it('answers notifications with nothing, pings with an empty result, and anything else with method not found', async () => {
    const { mcp } = setup()
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/write' })).toMatchObject({ id: 5, error: { code: -32601 } })
    expect(await mcp.handle('not json-rpc')).toMatchObject({ error: { code: -32600 } })
  })
  it('gives nothing while it is turned off in Settings, and says where to turn it on', async () => {
    const { mcp } = setup({ enabled: false })
    const r = await call(mcp, 'list_meetings')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Settings')
    expect(r.text).not.toContain('Budget')
  })
  it('lists meetings newest first, with who was in them, and finds them by words', async () => {
    const { mcp, older, newer } = setup()
    const all = await json(mcp, 'list_meetings')
    expect(all.map((m: { id: string }) => m.id)).toEqual([newer.id, older.id])
    expect(all[1]).toMatchObject({ title: 'Budget review', start: '2026-11-01T17:00:00.000Z', end: '2026-11-01T17:25:00.000Z', people: ['Ann Lee'], app: 'Zoom' })
    expect((await json(mcp, 'list_meetings', { limit: 1 })).map((m: { id: string }) => m.id)).toEqual([newer.id])
    expect((await json(mcp, 'list_meetings', { query: 'travel' })).map((m: { id: string }) => m.id)).toEqual([older.id])
  })
  it('gives a meeting with its own notes and the written summary', async () => {
    const { mcp, older } = setup()
    expect(await json(mcp, 'get_meeting', { id: older.id })).toMatchObject({ id: older.id, title: 'Budget review', myNotes: 'travel flat', summary: '## Budget\n- Travel stays flat.' })
  })
  it('gives the transcript as timed lines with who said them, the person by name, without hidden echo lines', async () => {
    const { mcp, older } = setup()
    expect((await call(mcp, 'get_transcript', { id: older.id })).text).toBe('[00:05] Sam Rivera: Can we keep travel flat?\n[01:05] Ann Lee: Travel spend is down a little.\n[01:10] Them: Sure.')
    const lines = await json(mcp, 'get_transcript', { id: older.id, format: 'lines' })
    expect(lines[0]).toEqual({ start_ms: 5000, end_ms: 7000, speaker: 'Sam Rivera', is_me: true, text: 'Can we keep travel flat?' })
    expect(lines).toHaveLength(3)
  })
  it('searches every meeting, with the matched words marked', async () => {
    const { mcp, older } = setup()
    const hits = await json(mcp, 'search', { query: 'travel' })
    expect(hits[0]).toMatchObject({ meeting_id: older.id, title: 'Budget review' })
    expect(hits[0].snippet).toMatch(/\*\*travel\*\*/i)
  })
  it("gives the audio files' paths on this Mac", async () => {
    const { mcp, older, dir } = setup()
    expect(await json(mcp, 'get_audio', { id: older.id })).toEqual({ files: [
      { track: 'me', who: 'Sam Rivera (the microphone)', path: join(dir, 'meetings', older.id, 'me.m4a') },
      { track: 'them', who: 'the other side of the call', path: join(dir, 'meetings', older.id, 'them.m4a') },
    ] })
  })
  it('says plainly when a meeting is not there or an argument is wrong', async () => {
    const { mcp } = setup()
    expect(await call(mcp, 'get_meeting', { id: 'nope' })).toMatchObject({ isError: true, text: expect.stringContaining('No meeting') })
    expect(await call(mcp, 'get_transcript', {})).toMatchObject({ isError: true })
    expect(await call(mcp, 'delete_everything')).toMatchObject({ isError: true })
  })
  it('a meeting in the Trash is not there for AI apps', async () => {
    const { mcp, store, older, newer } = setup()
    store.trashMeeting(older.id, 1)
    expect((await json(mcp, 'list_meetings')).map((m: { id: string }) => m.id)).toEqual([newer.id])
    expect(await json(mcp, 'search', { query: 'travel' })).toEqual([])
    for (const tool of ['get_meeting', 'get_transcript', 'get_audio']) expect(await call(mcp, tool, { id: older.id })).toMatchObject({ isError: true, text: expect.stringContaining('No meeting') })
  })
})

// a Unix socket on a Mac and Linux, a named pipe on Windows
describe('the MCP socket', () => {
  it('speaks one JSON message a line, and knows which apps are connected', async () => {
    const { mcp, dir } = setup()
    const path = mcpAddress(process.platform, dir, randomBytes(8).toString('hex'))
    const seen: string[][] = []
    const server = await serveMcp(path, mcp, (names) => seen.push(names))
    try {
      const sock = connect(path)
      const replies: unknown[] = []
      let buf = ''
      sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
      // two messages in one write, the second split across writes
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude' } } }) + '\n' + '{"jsonrpc":"2.0","id":2,')
      sock.write('"method":"ping"}\n')
      await expect.poll(() => replies.length).toBe(2)
      expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
      expect(server.clients()).toEqual(['Claude'])
      sock.end()
      await expect.poll(() => server.clients()).toEqual([])
      expect(seen).toEqual([['Claude'], []])
    } finally { await server.close() }
  })
  it.skipIf(process.platform === 'win32')('replaces a socket file left by a crash', async () => {
    const { mcp, dir } = setup()
    const path = join(dir, 'mcp.sock')
    writeFileSync(path, '')
    const server = await serveMcp(path, mcp, () => {})
    await server.close()
  })
})
