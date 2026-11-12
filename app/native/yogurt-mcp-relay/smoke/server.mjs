// A stand-in for Yogurt's MCP server (src/main/mcp/socket.ts): the same place to listen per OS and the same
// framing, one JSON message a line. node server.mjs PROFILE [args Yogurt was started with...]
// It writes server.pid and server.args to the profile, then ready once it listens. Methods: initialize, ping,
// echo (answers with params.text) and bye (closes every connection, as Yogurt quitting would).
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const [profile, ...args] = process.argv.slice(2)
writeFileSync(join(profile, 'server.pid'), String(process.pid))
writeFileSync(join(profile, 'server.args'), JSON.stringify(args))
const log = (s) => appendFileSync(join(profile, 'server.log'), s + '\n')

const conns = new Set()
const server = createServer((sock) => {
  conns.add(sock)
  log('connected')
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.method === 'bye') { for (const c of conns) c.destroy(); continue }
      const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'yogurt', version: '0.0.0' } }
        : msg.method === 'echo' ? { echo: msg.params.text } : {}
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
    }
  })
  sock.on('end', () => log('end'))
  sock.on('close', () => { conns.delete(sock); log('closed') })
  sock.on('error', () => {})
})

let address
if (process.platform === 'win32') address = `\\\\.\\pipe\\yogurt-mcp-${randomBytes(16).toString('hex')}`
else { address = join(profile, 'mcp.sock'); if (existsSync(address)) unlinkSync(address) }
server.listen(address, () => {
  if (process.platform === 'win32') { writeFileSync(join(profile, 'mcp.pipe.part'), address); renameSync(join(profile, 'mcp.pipe.part'), join(profile, 'mcp.pipe')) }
  writeFileSync(join(profile, 'ready'), address)
})
