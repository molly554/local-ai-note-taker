import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_CONTEXT, CloudError, cloudLlm, withCloud } from '../src/main/notes/cloud'
import { enhance, roughTokens, type Llm } from '../src/main/notes/enhance'
import type { NotesModel } from '../src/main/notes/model'
import { cloudSetting, cloudView } from '../src/main/settings'
import { cloudAddress } from '../src/shared/cloud'
import type { Segment } from '../src/main/store'

type Asked = { path: string; auth: string | undefined; body: { model: string; stream: boolean; max_tokens?: number; temperature?: number; messages: Array<{ role: string; content: string }> } }

/** a service that speaks the OpenAI chat API on this computer: it keeps what it was asked and answers in pieces, as they do */
let server: Server | undefined
async function service(answer: (asked: Asked) => string[] | number): Promise<{ url: string; asked: Asked[] }> {
  const asked: Asked[] = []
  const read = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => ok(s)) })
  server = createServer(async (req, res) => {
    const a: Asked = { path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(await read(req)) }
    asked.push(a)
    const pieces = answer(a)
    if (typeof pieces === 'number') { res.writeHead(pieces, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Incorrect API key provided"}}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': keep-alive\n\n')
    for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, asked }
}
afterEach(() => { server?.close(); server = undefined })

describe('the cloud model', () => {
  it('asks the service the way the OpenAI chat API is asked, and gives the answer as it is written', async () => {
    const s = await service(() => ['## Plan\n', '- Ship on ', 'Tuesday'])
    const got: string[] = []
    const llm = cloudLlm({ url: `${s.url}/`, model: 'some-model', key: 'secret-key' })
    const text = await llm.chat('Write the notes.', (t) => got.push(t), { maxTokens: 700, temperature: 0.2, before: ['Earlier prompt', 'Earlier answer'] })
    expect(text).toBe('## Plan\n- Ship on Tuesday')
    expect(got.join('')).toBe('## Plan\n- Ship on Tuesday')
    expect(got.length).toBeGreaterThan(1)
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0].path).toBe('/v1/chat/completions')
    expect(s.asked[0].auth).toBe('Bearer secret-key')
    expect(s.asked[0].body).toEqual({
      model: 'some-model', stream: true, max_tokens: 700, temperature: 0.2,
      messages: [{ role: 'user', content: 'Earlier prompt' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Write the notes.' }],
    })
  })

  it('leaves out the thinking a model shows before its answer', async () => {
    const s = await service(() => ['<think>The person wants', ' notes.</think>', '- Done'])
    const got: string[] = []
    expect(await cloudLlm({ url: s.url, model: 'm', key: 'k' }).chat('x', (t) => got.push(t))).toBe('- Done')
    expect(got.join('')).toBe('- Done')
  })

  it('says what the service said when it refuses', async () => {
    const s = await service(() => 401)
    const failed = cloudLlm({ url: s.url, model: 'm', key: 'wrong' }).chat('x', () => {})
    await expect(failed).rejects.toBeInstanceOf(CloudError)
    await expect(failed).rejects.toThrow(/401.*Incorrect API key/)
  })

  it('has no tokenizer here, so it counts by the guess that is on the high side for every script', async () => {
    const llm = cloudLlm({ url: 'http://127.0.0.1:9/v1', model: 'm', key: 'k' })
    expect(llm.contextSize).toBe(CLOUD_CONTEXT)
    expect(await llm.count(['发布计划', 'abcdef'])).toEqual([roughTokens('发布计划'), roughTokens('abcdef')])
  })

  it('writes a long Chinese meeting in parts that each fit, through the notes pipeline', async () => {
    const s = await service((a) => [a.body.max_tokens === 700 ? '### 议题\n- 要点' : '## 摘要\n- **You:** 跟进'])
    const segments: Segment[] = Array.from({ length: 2600 }, (_, i) => ({ id: i, meetingId: 'm', track: i % 2 ? 'them' as const : 'me' as const, startMs: i * 5000, endMs: i * 5000 + 5000, text: `我们今天讨论第${i + 1}个议题主要是关于产品发布的时间安排和定价策略。`, speaker: null }))
    const md = await enhance({ meeting: { title: '', attendees: [] }, mine: '', segments, language: 'zh' }, cloudLlm({ url: s.url, model: 'm', key: 'k' }), () => {})
    expect(md).toContain('## 摘要')
    const parts = s.asked.filter((a) => a.body.max_tokens === 700)
    expect(parts.length).toBeGreaterThan(1)
    for (const a of s.asked) expect(roughTokens(a.body.messages.at(-1)!.content) + (a.body.max_tokens ?? 0)).toBeLessThanOrEqual(CLOUD_CONTEXT)
  })
})

describe('the switch in front of the notes model', () => {
  const local = (): { model: NotesModel; asked: string[] } => {
    const asked: string[] = []
    const llm: Llm = { contextSize: 8192, count: async (xs) => xs.map((x) => x.length), chat: async (p) => { asked.push(p); return 'local' } }
    return { asked, model: { llm: async () => llm, unload: async () => {}, loaded: () => undefined, needsLoad: () => true } }
  }
  it('uses the model on this computer until the cloud one is turned on and filled in, and loads nothing here while it is', async () => {
    const s = await service(() => ['cloud'])
    const l = local()
    let on = false
    const model = withCloud(l.model, () => (on ? { url: s.url, model: 'm', key: 'k' } : null))
    expect(await (await model.llm()).chat('one', () => {})).toBe('local')
    expect(model.needsLoad()).toBe(true)
    on = true
    expect(await (await model.llm()).chat('two', () => {})).toBe('cloud')
    expect(model.needsLoad()).toBe(false)
    expect(l.asked).toEqual(['one'])
    expect(s.asked.map((a) => a.body.messages[0].content)).toEqual(['two'])
  })
})

describe('the cloud setting', () => {
  const open = (kept: string) => (kept.startsWith('sealed:') ? kept.slice(7) : null)
  it('is off unless it is turned on, its address can be sent to, and its model and key are there', () => {
    const full = { on: true, url: ' https://api.example.com/v1/ ', model: ' some-model ', key: 'sealed:abc' }
    expect(cloudSetting({ cloud: full }, open)).toEqual({ url: 'https://api.example.com/v1', model: 'some-model', key: 'abc' })
    expect(cloudSetting({}, open)).toBeNull()
    expect(cloudSetting({ cloud: { ...full, on: false } }, open)).toBeNull()
    expect(cloudSetting({ cloud: { ...full, url: 'api.example.com/v1' } }, open)).toBeNull()
    expect(cloudSetting({ cloud: { ...full, url: 'file:///etc/passwd' } }, open)).toBeNull()
    expect(cloudSetting({ cloud: { ...full, model: ' ' } }, open)).toBeNull()
    expect(cloudSetting({ cloud: { ...full, key: undefined } }, open)).toBeNull()
    // a key this computer can no longer unseal (the settings file came from another one)
    expect(cloudSetting({ cloud: { ...full, key: 'something else' } }, open)).toBeNull()
  })
  it('shows Settings whether a key is kept, never the key', () => {
    expect(cloudView({ cloud: { on: true, url: 'https://x/v1', model: 'm', key: 'sealed:abc' } })).toEqual({ on: true, url: 'https://x/v1', model: 'm', hasKey: true })
    expect(cloudView({})).toEqual({ on: false, url: '', model: '', hasKey: false })
  })
  it('takes http and https addresses only', () => {
    expect(cloudAddress('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(cloudAddress('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(cloudAddress('ftp://example.com')).toBeNull()
    expect(cloudAddress('')).toBeNull()
    expect(cloudAddress(undefined)).toBeNull()
  })
})
