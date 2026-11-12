import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/** yogurt-audio://<meetingId>/<track>: a meeting's recording, for the transcript's player */
export const AUDIO_SCHEME = 'yogurt-audio'
const TRACKS = ['me', 'them'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The bytes a Range header asks for (the first range only): null for the whole file, 'bad' when it can't be served */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return 'bad'
  if (!m[1]) {
    const n = Number(m[2])
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : 'bad'
  }
  const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return start < size && start <= end ? { start, end } : 'bad'
}

const notFound = () => new Response(null, { status: 404 })

export type AudioExt = 'm4a' | 'ogg' | 'wav'
const TYPES: Record<AudioExt, string> = { m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' }
/**
 * The files a meeting's tracks may be, in the order looked for: a Mac records m4a (HE-AAC), Windows and Linux Ogg Opus.
 * Each also plays the other's, so a backup from another computer plays. Fake mode writes wav stand-ins.
 */
export function audioExts(platform: string, fake: boolean): AudioExt[] {
  if (fake) return ['wav']
  return platform === 'darwin' ? ['m4a', 'ogg'] : ['ogg', 'm4a']
}
/** The file of one track in a meeting's folder: the first of these kinds that exists */
export function trackFile(dir: string, track: string, exts: readonly AudioExt[]): string | null {
  for (const ext of exts) { const f = join(dir, `${track}.${ext}`); if (existsSync(f)) return f }
  return null
}

/**
 * Serves only me and them of a meeting the store knows, from its own folder, once its files are final
 * (the m4a is only playable after the recorder closes it). Range requests let the player seek.
 */
export function createAudioHandler(p: { dirOf: (id: string) => string; known: (id: string) => boolean; ready: (id: string) => Promise<void>; exts: readonly AudioExt[] }) {
  return async (req: Request): Promise<Response> => {
    let url: URL
    try { url = new URL(req.url) } catch { return notFound() }
    const id = url.hostname, track = url.pathname.slice(1)
    if (url.protocol !== `${AUDIO_SCHEME}:` || !UUID.test(id) || !(TRACKS as readonly string[]).includes(track) || !p.known(id)) return notFound()
    await p.ready(id)
    const file = trackFile(p.dirOf(id), track, p.exts)
    if (!file) return notFound()
    let size: number
    try { size = statSync(file).size } catch { return notFound() }
    const type = TYPES[file.slice(file.lastIndexOf('.') + 1) as AudioExt]
    const range = parseRange(req.headers.get('range'), size)
    if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const { start, end } = range ?? { start: 0, end: size - 1 }
    const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream) : null
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size ? end - start + 1 : 0) }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    return new Response(body, { status: range ? 206 : 200, headers })
  }
}
