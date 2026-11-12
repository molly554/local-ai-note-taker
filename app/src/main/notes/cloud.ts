import { cleanAnswer, streamCleaner } from '../../engine/control'
import type { Cloud } from '../../shared/cloud'
import { roughTokens, type Llm } from './enhance'
import type { NotesModel } from './model'

/** What a cloud model is taken to read at once: services differ and none says, so the same as the local model is asked for */
export const CLOUD_CONTEXT = 32_768

/** the service said no: its status and the start of what it said, for the log and the note's error */
export class CloudError extends Error {
  constructor(readonly status: number, detail: string) { super(`The cloud model answered ${status}${detail ? `: ${detail}` : ''}`) }
}

/**
 * The cloud model as the notes need it. Tokens are guessed (a model somewhere else has no tokenizer here), on the high
 * side for every script, so a prompt never outgrows the context it is given. The answer comes as it is written
 * (server-sent events), with any thinking it shows taken out like the local model's.
 */
export function cloudLlm(c: Cloud, signal?: AbortSignal, send: typeof fetch = fetch): Llm {
  return {
    contextSize: CLOUD_CONTEXT,
    count: async (texts) => texts.map(roughTokens),
    async chat(prompt, onToken, o) {
      const messages = [...(o?.before ?? []).map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })), { role: 'user', content: prompt }]
      const res = await send(`${c.url.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, messages, stream: true, ...(o?.maxTokens ? { max_tokens: o.maxTokens } : {}), ...(o?.temperature !== undefined ? { temperature: o.temperature } : {}) }),
      })
      if (!res.ok || !res.body) throw new CloudError(res.status, (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))
      const clean = streamCleaner()
      const decoder = new TextDecoder()
      let text = '', rest = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        rest += decoder.decode(chunk, { stream: true })
        const lines = rest.split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          // "data: {…}" a piece; "data: [DONE]" the end; anything else (comments, blank lines) is not for us
          const data = line.startsWith('data:') ? line.slice(5).trim() : ''
          if (!data || data === '[DONE]') continue
          let piece: unknown
          try { piece = JSON.parse(data).choices?.[0]?.delta?.content } catch { continue }
          if (typeof piece !== 'string' || !piece) continue
          text += piece
          const out = clean.push(piece)
          if (out) onToken(out)
        }
      }
      const last = clean.end()
      if (last) onToken(last)
      return cleanAnswer(text)
    },
  }
}

/** The notes model, or the cloud one while it is turned on and filled in: nothing is loaded on this computer then */
export function withCloud(local: NotesModel, cloud: () => Cloud | null, send?: typeof fetch): NotesModel {
  return {
    ...local,
    llm: async (signal) => { const c = cloud(); return c ? cloudLlm(c, signal, send) : local.llm(signal) },
    needsLoad: () => (cloud() ? false : local.needsLoad()),
  }
}
