import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import type { Mcp } from './server'

/** one message is never this big; a client sending more is cut off rather than growing memory */
const MAX_LINE = 1024 * 1024

/**
 * The MCP server on a Unix socket in the profile folder (a named pipe on Windows), one JSON message a line (MCP's stdio framing, which the
 * yogurt-mcp helper passes through). Only this Mac's user can open it. clients: the apps connected now, by the
 * name they gave (onClients hears every change, for Settings).
 */
export async function serveMcp(path: string, mcp: Mcp, onClients: (names: string[]) => void) {
  const names = new Map<Socket, string>()
  const changed = () => { try { onClients([...names.values()]) } catch (e) { console.error('mcp: telling about clients failed', e) } }
  const server = createServer((sock) => {
    let buf = ''
    // answers go out in the order the messages came, though some take longer to work out
    let chain = Promise.resolve()
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_LINE && !buf.includes('\n')) { sock.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg: unknown
        try { msg = JSON.parse(line) } catch { msg = null }
        const m = msg as { method?: string; params?: { clientInfo?: { name?: unknown } } } | null
        if (m?.method === 'initialize') {
          const name = m.params?.clientInfo?.name
          names.set(sock, typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'An AI app')
          changed()
        }
        chain = chain.then(async () => {
          const reply = msg === null ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON' } } : await mcp.handle(msg)
          if (reply && !sock.destroyed) sock.write(JSON.stringify(reply) + '\n')
        }).catch((e) => console.error('mcp: answering failed', e))
      }
    })
    const gone = () => { if (names.delete(sock)) changed() }
    sock.on('close', gone)
    sock.on('error', gone)
  })
  // a Windows named pipe is no file: nothing is left by a crash, and Windows decides who may open it
  const pipe = path.startsWith('\\\\.\\pipe\\')
  // a socket file left by a crash refuses to be listened on again
  if (!pipe && existsSync(path)) unlinkSync(path)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
  if (!pipe) chmodSync(path, 0o600)
  return {
    clients: () => [...names.values()],
    close: () => new Promise<void>((resolve) => {
      for (const s of names.keys()) s.destroy()
      server.close(() => resolve())
      // sockets that never said initialize are not in names: close waits on them otherwise
      server.unref()
    }),
  }
}
