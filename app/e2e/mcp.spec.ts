import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
const helper = join(import.meta.dirname, '../resources/bin/yogurt-mcp')

const fake = <T>(app: ElectronApplication, fn: string, arg?: unknown): Promise<T> =>
  app.evaluate((_e, [fn, arg]) => (globalThis as unknown as Record<string, Record<string, (a?: unknown) => unknown>>).__fake__[fn as string](arg), [fn, arg] as const) as Promise<T>

/** an AI app: starts yogurt-mcp as Claude would and talks MCP to it, one JSON message a line */
function aiApp(userData: string) {
  const child: ChildProcessWithoutNullStreams = spawn(helper, [], { env: { ...process.env, YOGURT_USER_DATA: userData, YOGURT_MCP_NO_LAUNCH: '1' } })
  const replies = new Map<number, unknown>()
  let buf = '', next = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); replies.set(m.id, m); buf = buf.slice(i + 1) } })
  const ask = async (method: string, params?: unknown) => {
    const id = next++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await expect.poll(() => replies.has(id)).toBe(true)
    return replies.get(id) as { result: { content?: Array<{ text: string }>; isError?: boolean; serverInfo?: { name: string } } }
  }
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await ask('tools/call', { name, arguments: args })
    return { text: r.result.content!.map((c) => c.text).join('\n'), isError: !!r.result.isError }
  }
  return { ask, tool, close: () => child.stdin.end() }
}

test('an AI app on this Mac reads meetings through yogurt-mcp only once Settings allows it, and Settings shows it connected', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-mcp-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  const ai = aiApp(userData)
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await fake(app, 'manyMeetings', { n: 2, clean: true })
    const hello = await ai.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude', version: '1' } })
    expect(hello.result.serverInfo!.name).toBe('yogurt')
    // off by default: nothing is read
    const off = await ai.tool('list_meetings')
    expect(off.isError).toBe(true)
    expect(off.text).toContain('Settings')

    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('ai-apps-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ai-apps-clients')).toHaveText('Connected now: Claude')
    await expect(page.getByTestId('ai-apps-command')).toHaveValue(/yogurt-mcp$/)
    await expect(page.getByTestId('ai-apps-claude')).toHaveCount(0)
    await expect(page.getByTestId('ai-apps')).toContainText('Copy this command and add it as a local MCP server in your AI app.')
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => {
        document.documentElement.dataset.copiedMcp = text
      } })
    })
    await page.getByTestId('ai-apps-copy').click()
    await expect(page.getByTestId('ai-apps-copy')).toHaveText('Copied')
    expect(await page.locator('html').getAttribute('data-copied-mcp')).toBe(await page.getByTestId('ai-apps-command').inputValue())

    const meetings = JSON.parse((await ai.tool('list_meetings')).text) as Array<{ id: string; title: string }>
    expect(meetings).toHaveLength(2)
    const transcript = await ai.tool('get_transcript', { id: meetings[0].id })
    expect(transcript.isError).toBe(false)
    expect(transcript.text).toMatch(/^\[\d\d:\d\d\] /)

    // the app goes: Settings says so; turned off again, nothing is read
    await toggle.click()
    expect((await ai.tool('list_meetings')).isError).toBe(true)
    ai.close()
    await toggle.click()
    await expect(page.getByTestId('ai-apps-clients')).toHaveCount(0)
  } finally { ai.close(); await app.close() }
})
