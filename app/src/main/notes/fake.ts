import type { ChatRequest, Engine } from '../engine'
import { fakePrompts } from '../fake'

/**
 * Fake mode: no model. The notes for the e2e meeting (meeting-me.wav / meeting-them.wav), streamed a few words at a
 * time, and one answer to any question about a meeting. The first line the person typed comes back marked as theirs. YOGURT_FAKE_LLM_MS sets the pause between pieces.
 */
export class FakeEngine implements Engine {
  async load() { return { contextSize: 32_768 } }
  async unload() {}
  async count(texts: string[]) { return texts.map((t) => Math.ceil(t.length / 4)) }
  async chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const prompt = req.messages.at(-1)?.content ?? ''
    fakePrompts.notes.push(prompt)
    if (prompt.startsWith('Suggest one existing folder')) {
      const data = JSON.parse(prompt.slice(prompt.indexOf('{')))
      return this.stream(JSON.stringify({ folder: data.folders[0]?.name ?? null, confidence: 0.95 }), onToken, signal)
    }
    // a question across meetings: like a small model, the first two meetings found with every part of each cited
    if (prompt.includes('</sources>')) {
      const meetings: Array<{ title: string; ns: number[] }> = []
      for (const m of prompt.matchAll(/^Meeting: (.+?) · .*$|^\[(\d+)\] /gm)) {
        if (m[1]) meetings.push({ title: m[1], ns: [] }); else meetings.at(-1)?.ns.push(Number(m[2]))
      }
      if (!meetings.length) return this.stream("I couldn't find that in your meetings.", onToken, signal)
      const cite = (ns: number[]) => ns.map((n) => `[${n}]`).join('')
      // nothing there answers it, and every source is cited anyway
      if (/politics\?\n<\/question>/.test(prompt)) return this.stream(`Nothing in your meetings is about that ${cite(meetings.flatMap((m) => m.ns))}.`, onToken, signal)
      return this.stream([
        'Here is what came up:',
        ...meetings.slice(0, 2).map((f) => `- In **${f.title}**, it was discussed ${cite(f.ns)}.`),
      ].join('\n'), onToken, signal)
    }
    // a question about the meeting: the same answer every time, a little different while it still records
    if (prompt.includes('<question>')) return this.stream([
      prompt.includes('still going on') ? 'So far, the plan is:' : 'The launch plan, in short:',
      '- The site goes live on **Tuesday**.',
      '- The email goes out on Wednesday morning.',
      // a link in an answer (from what was said or pasted) is never shown as one
      ...(prompt.includes('What was decided?\n</question>') ? ['- The plan is at [the launch page](https://example.com/plan).'] : []),
    ].join('\n'), onToken, signal)
    // a title from the notes, for a meeting with a generic one
    if (prompt.startsWith('Now give this meeting a title')) return this.stream('Launch plan and release notes', onToken, signal)
    // who was there, as the prompt says: shown, so a note written again for new people can be told apart
    const invited = /People invited: (.*)\. "You"/.exec(prompt)?.[1]
    const own = /<notes>\n([\s\S]*?)\n<\/notes>/.exec(prompt)?.[1].split('\n')[0].replace(/^\s*[-*]\s+/, '').trim()
    const md = [
      '## Launch plan',
      ...(own ? [`- <mine>${own}</mine>`] : []),
      '- The site goes live on **Tuesday**.',
      '  - The email goes out on Wednesday morning.',
      ...(invited && invited !== 'not known' ? [`- With ${invited}.`] : []),
      '## Release notes',
      '- A draft is due by Friday.',
      '## Next steps',
      // the name from the call when the transcript has it, plain words when it is Them
      `- **${prompt.includes('Bo Park: She will send a draft') ? 'Bo Park' : 'The others'}:** Send the release notes draft by Friday.`,
      '- **You:** Share the launch plan with the team.',
    ].join('\n')
    return this.stream(md, onToken, signal)
  }
  private async stream(md: string, onToken: (text: string) => void, signal?: AbortSignal): Promise<string> {
    const pause = Number(process.env.YOGURT_FAKE_LLM_MS ?? 60)
    let out = ''
    for (const piece of md.match(/\S+\s*/g) ?? []) {
      // like the real engine: a stopped answer ends where it is and comes back as it is, no error
      if (signal?.aborted) return out
      await new Promise((r) => setTimeout(r, pause))
      out += piece
      onToken(piece)
    }
    return out
  }
  async preload(messages: ChatRequest['messages']) { fakePrompts.preloads.push(messages.at(-1)?.content ?? ''); return 0 }
  /** words hashed into a vector: texts that share words point the same way, the same text always the same way */
  async embed(_modelPath: string, texts: string[]) { return texts.map(fakeVector) }
  async unloadEmbed() {}
  onExit() {}
  dispose() {}
}

/** what an EmbeddingGemma prompt puts before the text */
const EMBED_PREFIX = /^(?:task: [^|]*\| query: |title: [^|]*\| text: )/
function fakeVector(text: string): number[] {
  const v = new Array<number>(768).fill(0)
  for (const w of text.replace(EMBED_PREFIX, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2)) {
    let h = 2166136261
    for (const c of w) h = Math.imul(h ^ c.codePointAt(0)!, 16777619)
    v[(h >>> 0) % 768] += 1
  }
  // never all zero: a text with no words still has a direction
  v[0] += 0.01
  return v
}
