import type { Meeting, Store } from '../store'

/**
 * Yogurt as an MCP server, so an AI app on this Mac (Claude, Cursor, …) can read the person's meetings: JSON-RPC
 * messages in, answers out (socket.ts carries them; the yogurt-mcp helper connects the app to it). Reading only.
 * Off until the person turns it on in Settings: until then every tool says where to turn it on and gives nothing.
 * Text here goes to the other app's model, never to Yogurt's interface, so it is not translated.
 */

type Track = 'me' | 'them'
export type McpDeps = {
  store: Pick<Store, 'meeting' | 'meetings' | 'segments' | 'notes' | 'search'>
  enabled: () => boolean
  /** the person using Yogurt, by name: "You" means nothing to another app */
  me: () => string
  version: string
  /** a finished meeting's audio files (none while it records) */
  audio: (id: string) => Promise<Array<{ track: Track; path: string }>>
  /** the computer, for the words other apps' models read (a Mac when left out) */
  platform?: string
}
export type Mcp = { handle(msg: unknown): Promise<object | null> }

/** newest first: the app asked for one of these, it gets that one; otherwise the newest */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const id = { type: 'string', description: 'The meeting id, from list_meetings or search' }
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
/** The tools, in this computer's words: a Mac records AAC in .m4a, Windows and Linux Ogg Opus (a backup can bring either) */
export const mcpTools = (platform: string) => [
  { name: 'list_meetings', description: 'Meetings recorded in Lynote NoteTaker, newest first: id, title, start and end (ISO times), people invited, call app. Optional query finds meetings by words in their title, transcript or notes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Most to return (default 20, at most 100)' }, before: { type: 'string', description: 'Only meetings that started before this ISO time, to page back' } } } },
  { name: 'get_meeting', description: "One meeting: its details, the notes the person typed (myNotes) and Lynote NoteTaker's written summary (Markdown).",
    inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'get_transcript', description: 'What was said in a meeting, line by line with who said it. format "text" (default): "[mm:ss] Name: words" lines. format "lines": JSON with start_ms, end_ms, speaker, is_me and text. "Them" is the other side of the call when the call app gave no name.',
    inputSchema: { type: 'object', properties: { id, format: { type: 'string', enum: ['text', 'lines'] } }, required: ['id'] } },
  { name: 'search', description: 'Finds words across every meeting (titles, transcripts, notes): meeting id, title, start and a snippet with the matched words in **bold**.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Most meetings to return (default 20, at most 100)' } }, required: ['query'] } },
  { name: 'get_audio', description: platform === 'darwin'
    ? "A meeting's recording as files on this Mac: one per side (track me: the person's microphone; them: the other side of the call), AAC in .m4a. Gives paths, which apps on this Mac can open."
    : "A meeting's recording as files on this computer: one per side (track me: the person's microphone; them: the other side of the call), Ogg Opus in .ogg (AAC in .m4a for a meeting recorded on a Mac). Gives paths, which apps on this computer can open.",
    inputSchema: { type: 'object', properties: { id }, required: ['id'] } },
].map((t) => ({ ...t, annotations: readOnly }))
export const MCP_TOOLS = mcpTools('darwin')

class Refusal extends Error {}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString())
const clock = (ms: number) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60; const p = (n: number) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}` }
const limitOf = (v: unknown) => (typeof v === 'number' && v >= 1 ? Math.min(100, Math.floor(v)) : 20)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function createMcp(d: McpDeps): Mcp {
  const mac = (d.platform ?? 'darwin') === 'darwin'
  const listed = mcpTools(d.platform ?? 'darwin')
  const summary = (m: Meeting) => ({ id: m.id, title: m.title, start: iso(m.startedAt), end: iso(m.endedAt), people: m.attendees.map((a) => a.name), app: m.app, recording: m.state === 'recording' })
  const meetingOf = (v: unknown) => {
    const m = typeof v === 'string' ? d.store.meeting(v) : undefined
    // a meeting in the Trash is gone as far as AI apps can tell
    if (!m || m.trashedAt != null) throw new Refusal(`No meeting with id ${JSON.stringify(v ?? null)}. list_meetings or search gives the ids.`)
    return m
  }
  const who = (speaker: string | null, track: Track) => (track === 'me' || speaker === 'me' ? d.me() || 'You' : speaker || 'Them')

  const tools: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
    async list_meetings(a) {
      const limit = limitOf(a.limit)
      const q = text(a.query)
      const before = text(a.before) ? Date.parse(String(a.before)) : undefined
      const found = q
        ? d.store.search(q, limit).map((h) => d.store.meeting(h.meetingId)).filter((m): m is Meeting => !!m && (before == null || m.startedAt < before))
        : d.store.meetings({ before: Number.isNaN(before) ? undefined : before, limit })
      return JSON.stringify(found.map(summary), null, 2)
    },
    async get_meeting(a) {
      const m = meetingOf(a.id)
      const n = d.store.notes(m.id)
      return JSON.stringify({ ...summary(m), myNotes: n.mine, summary: n.enhanced }, null, 2)
    },
    async get_transcript(a) {
      const m = meetingOf(a.id)
      const lines = d.store.segments(m.id)
      if (a.format === 'lines') return JSON.stringify(lines.map((s) => ({ start_ms: s.startMs, end_ms: s.endMs, speaker: who(s.speaker, s.track), is_me: s.track === 'me', text: s.text })), null, 2)
      return lines.map((s) => `[${clock(s.startMs)}] ${who(s.speaker, s.track)}: ${s.text}`).join('\n') || 'Nothing was transcribed in this meeting.'
    },
    async search(a) {
      const q = text(a.query)
      if (!q) throw new Refusal('search needs a query.')
      return JSON.stringify(d.store.search(q, limitOf(a.limit)).flatMap((h) => {
        const m = d.store.meeting(h.meetingId)
        return m ? [{ meeting_id: m.id, title: m.title, start: iso(m.startedAt), snippet: h.parts.map((p) => (p.hit ? `**${p.text}**` : p.text)).join('') || h.snippet }] : []
      }), null, 2)
    },
    async get_audio(a) {
      const m = meetingOf(a.id)
      if (m.state === 'recording') throw new Refusal('This meeting is still being recorded. Its audio is ready once it stops.')
      const files = (await d.audio(m.id)).map((f) => ({ track: f.track, who: f.track === 'me' ? `${d.me() || 'The person'} (the microphone)` : 'the other side of the call', path: f.path }))
      return JSON.stringify({ files }, null, 2)
    },
  }

  const ok = (msgId: unknown, result: object) => ({ jsonrpc: '2.0', id: msgId, result })
  const fail = (msgId: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: msgId ?? null, error: { code, message } })
  const said = (msgId: unknown, body: string, isError = false) => ok(msgId, { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) })

  return {
    async handle(msg) {
      if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (msg as { method?: unknown }).method !== 'string') return fail(null, -32600, 'Not a JSON-RPC request')
      const { id: msgId, method, params } = msg as { id?: unknown; method: string; params?: Record<string, unknown> }
      // a notification: nothing comes back
      if (msgId === undefined) return null
      if (method === 'initialize') {
        const asked = params?.protocolVersion
        return ok(msgId, {
          protocolVersion: VERSIONS.includes(String(asked)) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'yogurt', title: 'Lynote NoteTaker', version: d.version },
          instructions: `Lynote NoteTaker holds the person's meeting notes, transcripts and recordings on this ${mac ? 'Mac' : 'computer'}. Use list_meetings or search to find a meeting, then get_meeting, get_transcript or get_audio.`,
        })
      }
      if (method === 'ping') return ok(msgId, {})
      if (method === 'tools/list') return ok(msgId, { tools: listed })
      if (method === 'tools/call') {
        const name = String(params?.name ?? '')
        const tool = tools[name]
        if (!tool) return said(msgId, `Lynote NoteTaker has no tool called ${name}.`, true)
        if (!d.enabled()) return said(msgId, 'Lynote NoteTaker has connecting AI apps turned off. The person can turn it on in Lynote NoteTaker: Settings, AI apps.', true)
        try { return said(msgId, await tool((params?.arguments as Record<string, unknown>) ?? {})) } catch (e) {
          if (e instanceof Refusal) return said(msgId, e.message, true)
          console.error(`mcp: ${name} failed`, e)
          return said(msgId, `Lynote NoteTaker couldn't do that (${name}). Try again.`, true)
        }
      }
      return fail(msgId, -32601, `Lynote NoteTaker doesn't do ${method}`)
    },
  }
}
