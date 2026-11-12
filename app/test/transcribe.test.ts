import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranscriber, isGarbled, requestTimeoutMs, wavBytes } from '../src/main/asr/transcribe'
import type { Chunk } from '../src/main/asr/chunker'

type Reply = { language?: string; prob?: number; segments?: Array<{ start: number; end: number; text: string }> }
const verbose = (r: Reply) => ({
  task: 'transcribe', language: r.language ?? 'english', detected_language: r.language ?? 'english', detected_language_probability: r.prob ?? 0.99,
  text: (r.segments ?? []).map((s) => s.text).join(''),
  segments: (r.segments ?? []).map((s, id) => ({ id, ...s, avg_logprob: -0.1, no_speech_prob: 0.01 })),
})

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())).then(() => { server = undefined }))

/** a stand-in whisper-server: records the form fields and the audio of each request and answers from the queue */
async function stub(replies: Reply[]) {
  const seen: Array<{ fields: Record<string, string>; wav: Buffer; path: string }> = []
  server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (d: Buffer) => parts.push(d))
    req.on('end', () => {
      const body = Buffer.concat(parts)
      const text = body.toString('latin1')
      const fields: Record<string, string> = {}
      for (const m of text.matchAll(/name="([^"]+)"(?!; filename)\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2]
      const start = body.indexOf('RIFF')
      seen.push({ fields, wav: body.subarray(start, start + 44), path: req.url ?? '' })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(verbose(replies[Math.min(seen.length - 1, replies.length - 1)])))
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen }
}

const chunk = (track: 'me' | 'them', startMs: number, sec = 2): Chunk => ({ track, startMs, samples: new Float32Array(16000 * sec) })
const say = (text: string, language = 'english', prob = 0.99): Reply => ({ language, prob, segments: [{ start: 0.5, end: 2, text: ` ${text}` }] })

describe('wavBytes', () => {
  it('writes a 16 kHz mono 16-bit wav header and the samples', () => {
    const b = wavBytes(Float32Array.from([0, 0.5, -1]))
    expect(b.toString('ascii', 0, 4)).toBe('RIFF')
    expect(b.toString('ascii', 8, 12)).toBe('WAVE')
    expect(b.readUInt16LE(22)).toBe(1)
    expect(b.readUInt32LE(24)).toBe(16000)
    expect(b.readUInt16LE(34)).toBe(16)
    expect(b.readUInt32LE(40)).toBe(6)
    expect(b.readInt16LE(46)).toBe(16384)
    expect(b.readInt16LE(48)).toBe(-32768)
  })
})

describe('transcribe', () => {
  it('tells which language each chunk was heard in, weighted by how much was said', async () => {
    const s = await stub([say('hola a todos, empezamos', 'spanish'), say('', 'english')])
    const heard: Array<[string, string, number]> = []
    const tr = createTranscriber({ url: async () => s.url, onLanguage: (track, lang, chars) => heard.push([track, lang, chars]) })
    await tr(chunk('them', 0))
    await tr(chunk('me', 0))
    expect(heard).toEqual([['them', 'spanish', 'hola a todos, empezamos'.length]])
  })
  it('posts the audio with the agreed settings and offsets the times by the chunk start', async () => {
    const s = await stub([{ segments: [{ start: 0.5, end: 2, text: ' Hello there.' }, { start: 2, end: 3.25, text: ' How are you?' }] }])
    const tr = createTranscriber({ url: async () => s.url })
    const out = await tr(chunk('them', 12_000, 4))
    expect(out).toEqual([
      { track: 'them', startMs: 12_500, endMs: 14_000, text: 'Hello there.' },
      { track: 'them', startMs: 14_000, endMs: 15_250, text: 'How are you?' },
    ])
    expect(s.seen[0].path).toBe('/inference')
    expect(s.seen[0].fields).toMatchObject({ response_format: 'verbose_json', language: 'auto', temperature: '0.0', no_timestamps: 'false' })
    expect(s.seen[0].wav.toString('ascii', 0, 4)).toBe('RIFF')
  })

  it('drops a line that only repeats the prompt, and keeps the real ones around it', async () => {
    const s = await stub([{ segments: [{ start: 0, end: 1, text: ' Alex Morgan of Zentrik.' }, { start: 1, end: 2, text: ' Shall we start with the roadmap?' }] }])
    const tr = createTranscriber({ url: async () => s.url, prompt: () => 'With Alex Morgan of Zentrik.' })
    expect((await tr(chunk('them', 0))).map((l) => l.text)).toEqual(['Shall we start with the roadmap?'])
  })
  it('drops a stock silence line from a chunk that was not clearly speech, but keeps a real one', async () => {
    const s = await stub([say('Thank you.')])
    const tr = createTranscriber({ url: async () => s.url })
    expect(await tr({ ...chunk('them', 0), clearMs: 100 })).toEqual([])
    expect((await tr({ ...chunk('them', 0), clearMs: 1200 })).map((l) => l.text)).toEqual(['Thank you.'])
    expect((await tr(chunk('them', 0))).map((l) => l.text)).toEqual(['Thank you.'])
  })
  it("sends the meeting's words as whisper's prompt, read on each chunk, and none when there are none", async () => {
    const s = await stub([say('one'), say('two'), say('three')])
    let words = 'Kickoff. With Tarun Mehra of Zentrik.'
    const tr = createTranscriber({ url: async () => s.url, prompt: () => words })
    await tr(chunk('them', 0))
    await tr(chunk('them', 2000), { partial: true })
    words = ''
    await tr(chunk('them', 4000))
    expect(s.seen.map((r) => r.fields.prompt)).toEqual(['Kickoff. With Tarun Mehra of Zentrik.', 'Kickoff. With Tarun Mehra of Zentrik.', undefined])
  })

  it('keeps each track in the language it was first heard in', async () => {
    const s = await stub([say('Buenos días a todos', 'spanish'), say('Hello everyone', 'english'), say('Seguimos con el tema', 'spanish'), say('Next point')])
    const tr = createTranscriber({ url: async () => s.url })
    await tr(chunk('me', 0))
    await tr(chunk('them', 0))
    await tr(chunk('me', 3000))
    await tr(chunk('them', 3000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['auto', 'auto', 'spanish', 'english'])
  })

  it('does not lock on a doubtful first guess', async () => {
    const s = await stub([say('Uh huh', 'welsh', 0.4), say('Right then, see you soon', 'english', 0.95), say('Fine by me')])
    const tr = createTranscriber({ url: async () => s.url })
    await tr(chunk('me', 0)); await tr(chunk('me', 3000)); await tr(chunk('me', 6000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['auto', 'auto', 'english'])
  })

  it('looks again, with the language left open, when a locked track comes back empty', async () => {
    const s = await stub([say('Buenos días a todos', 'spanish'), { language: 'spanish', segments: [] }, say('Now in English please', 'english')])
    const tr = createTranscriber({ url: async () => s.url })
    await tr(chunk('me', 0))
    const out = await tr(chunk('me', 3000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['auto', 'spanish', 'auto'])
    expect(out.map((x) => x.text)).toEqual(['Now in English please'])
    // and the new language is the one kept now
    await tr(chunk('me', 6000))
    expect(s.seen[3].fields.language).toBe('english')
  })

  it('keeps the lock when looking again finds nothing either: the chunk had no speech in it', async () => {
    const s = await stub([say('Buenos días a todos', 'spanish'), { language: 'spanish', segments: [] }, { language: 'english', segments: [] }, say('Seguimos', 'spanish')])
    const tr = createTranscriber({ url: async () => s.url })
    await tr(chunk('me', 0))
    expect(await tr(chunk('me', 3000))).toEqual([])
    await tr(chunk('me', 6000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['auto', 'spanish', 'auto', 'spanish'])
  })

  it('looks again when a locked track comes back garbled', async () => {
    const s = await stub([say('Buenos días a todos', 'spanish'), say('la la la la la la la la la la la la', 'spanish'), say('Hola de nuevo', 'spanish')])
    const tr = createTranscriber({ url: async () => s.url })
    await tr(chunk('me', 0))
    const out = await tr(chunk('me', 3000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['auto', 'spanish', 'auto'])
    expect(out[0].text).toBe('Hola de nuevo')
  })

  it("English only: no request asks whisper to guess the language, and what was heard is reported as English, not a guess", async () => {
    const s = await stub([say('Hello everyone', 'welsh', 0.6), say('Next', 'welsh'), say('Next point', 'spanish')])
    let forced: string | undefined = 'en'
    const heard: Array<[string, number, boolean]> = []
    const tr = createTranscriber({ url: async () => s.url, language: () => forced, onLanguage: (_t, lang, n, locked) => heard.push([lang, n, locked]) })
    await tr(chunk('me', 0))
    await tr(chunk('me', 2000), { partial: true })
    expect(s.seen.map((x) => x.fields.no_language_probabilities)).toEqual(['true', 'true'])
    expect(heard).toEqual([['english', 'Hello everyone'.length, true]])
    // Multi-language: the final asks for the guess again
    forced = undefined
    await tr(chunk('them', 6000))
    expect(s.seen[2].fields.no_language_probabilities).toBeUndefined()
  })

  it('English only: every chunk, quick or careful, is told English, never auto-detected, and still reports what it heard', async () => {
    const s = await stub([say('Hello everyone'), say('Next'), say('la la la la la la la la la la la la'), say('Next point')])
    let forced: string | undefined = 'en'
    const heard: Array<[string, string, boolean]> = []
    const tr = createTranscriber({ url: async () => s.url, language: () => forced, onLanguage: (track, lang, _n, locked) => heard.push([track, lang, locked]) })
    await tr(chunk('me', 0))
    await tr(chunk('me', 2000), { partial: true })
    // garbled: no second look with the language open, English stays
    await tr(chunk('me', 3000))
    expect(s.seen.map((x) => x.fields.language)).toEqual(['en', 'en', 'en'])
    expect(heard).toEqual([['me', 'english', true]])
    // Multi-language from the next chunk on: back to detecting
    forced = undefined
    await tr(chunk('them', 6000))
    expect(s.seen[3].fields.language).toBe('auto')
  })

  it('leaves out noise tags and blank answers', async () => {
    const s = await stub([{ segments: [{ start: 0, end: 1, text: ' [BLANK_AUDIO]' }, { start: 1, end: 2, text: ' (music)' }, { start: 2, end: 3, text: '  ' }, { start: 3, end: 4, text: ' Okay then.' }] }])
    const out = await createTranscriber({ url: async () => s.url })(chunk('me', 0, 5))
    expect(out.map((x) => x.text)).toEqual(['Okay then.'])
  })

  it('asks to recover once when the server is gone, then tries again', async () => {
    const s = await stub([say('Back again')])
    let calls = 0
    const tr = createTranscriber({
      url: async () => (calls++ === 0 ? 'http://127.0.0.1:1' : s.url),
      recover: async () => true,
    })
    const out = await tr(chunk('me', 0))
    expect(out.map((x) => x.text)).toEqual(['Back again'])
    expect(calls).toBe(2)
  })

  it('gives the error when recovery is refused', async () => {
    const tr = createTranscriber({ url: async () => 'http://127.0.0.1:1', recover: async () => false })
    await expect(tr(chunk('me', 0))).rejects.toThrow()
  })
})

describe('isGarbled', () => {
  it('flags empty text, a word said over and over, and nothing else', () => {
    expect(isGarbled('')).toBe(true)
    expect(isGarbled('la la la la la la la la la la')).toBe(true)
    expect(isGarbled('ha ha ha')).toBe(false)
    expect(isGarbled('We will ship on Tuesday and then review.')).toBe(false)
    expect(isGarbled('はいはいはいはいはいはいはいはいはいはいはい')).toBe(true)
    expect(isGarbled('明日の会議は十時からです')).toBe(false)
  })
  it('a request may take 4 times the chunk\'s length, at least 30 s: a hung server costs seconds, not minutes', () => {
    expect(requestTimeoutMs(16000 * 2)).toBe(30_000)
    expect(requestTimeoutMs(16000 * 15)).toBe(60_000)
  })
})

describe('partials', () => {
  it('asks for one greedy reading (beam_size 1) and leaves the language lock alone', async () => {
    const s = await stub([say('we should move the'), say('we should move the launch to friday')])
    const tr = createTranscriber({ url: async () => s.url })
    const quick = await tr(chunk('them', 1000), { partial: true })
    expect(quick.map((l) => l.text)).toEqual(['we should move the'])
    expect(s.seen[0].fields.beam_size).toBe('1')
    expect(s.seen[0].fields.language).toBe('auto')
    // its language is never read, so whisper skips the second encoder pass that guesses it
    expect(s.seen[0].fields.no_language_probabilities).toBe('true')
    const final = await tr(chunk('them', 1000))
    expect(final.map((l) => l.text)).toEqual(['we should move the launch to friday'])
    expect(s.seen[1].fields.beam_size).toBeUndefined()
    expect(s.seen[1].fields.no_language_probabilities).toBeUndefined()
    // the partial did not lock the language: the final asked with it open
    expect(s.seen[1].fields.language).toBe('auto')
  })
})

describe('the language lock is reported', () => {
  it('says whether the track was locked when the language was heard, so one odd chunk before the lock changes nothing', async () => {
    const s = await stub([say('hola a todos', 'spanish', 0.95), say('bueno gracias', 'spanish', 0.95)])
    const heard: Array<[string, boolean]> = []
    const tr = createTranscriber({ url: async () => s.url, onLanguage: (_t, lang, _n, locked) => heard.push([lang, locked]) })
    await tr(chunk('them', 0))
    await tr(chunk('them', 3000))
    expect(heard).toEqual([['spanish', false], ['spanish', true]])
  })
})
