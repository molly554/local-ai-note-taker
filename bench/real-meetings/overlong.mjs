// What happens to a prompt that does not fit, on a real model: the app's own engine, Qwen3 1.7B (the smallest notes
// model in the catalogue), a context of 8,192 tokens (the least the app takes when memory is short), one real meeting.
//   node bench/real-meetings/fetch.mjs --models     once: 2.2 GB
//   node bench/real-meetings/overlong.mjs           after pnpm install; slow, the model runs on the processor
// On the machine the results come from (4 cores, no graphics) the model read about 14 tokens a second and wrote
// about 0.3: part 1 took 17 minutes, and the run was stopped by hand after upstream's first call in part 2 (47
// minutes). The whole of part 2 is five calls or so; give it a faster machine.
// 1. Where is it cut? Three passwords are put into a transcript, near the start, the middle and the end, and the
//    model is asked to list them: once with a transcript that fits (to see it can), once with one that does not
//    (two meetings one after the other).
// 2. The notes pipeline itself, before (upstream) and after (this fork), on the meeting where upstream's prompt
//    overshoots the most: what each call was sent, how much of it the engine read, and whether it failed.
// What the model wrote is kept in data/ (not in the repository): results-overlong.json has the counts only.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aishell4, data, here, segmentsOf, useAppSource } from './meetings.mjs'

process.env.YOGURT_ENGINE_GPU = 'off'
useAppSource()
const { createLlm } = await import('../../app/src/engine/llm.ts')
const builds = { upstream: await import('./upstream/enhance.ts'), fork: await import('../../app/src/main/notes/enhance.ts') }

const CONTEXT = 8192
const engine = createLlm()
const t0 = performance.now()
const { contextSize } = await engine.load(join(data, 'models', 'Qwen3-1.7B-Q8_0.gguf'), CONTEXT, CONTEXT)
const out = { node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10), model: 'Qwen3 1.7B Q8_0', contextSize, loadSeconds: Math.round((performance.now() - t0) / 1000), passwords: [], pipeline: [] }
const kept = {}
const save = () => {
  writeFileSync(join(here, 'results-overlong.json'), JSON.stringify(out, null, 1) + '\n')
  writeFileSync(join(data, 'overlong-answers.json'), JSON.stringify(kept, null, 1) + '\n')
}
const readOf = (timing) => Number((/read ([\d,]+) tok/.exec(timing ?? '')?.[1] ?? '').replace(/,/g, '')) || null

const meetings = aishell4()
// for the passwords: two meetings one after the other, so the transcript is well over the context
const turns = meetings.slice(0, 2).flatMap((m) => builds.fork.transcriptText(segmentsOf(m, 'call, no names')).split('\n'))

// for the pipeline: the meeting where upstream's prompt overshoots the most, heard as a call with names shown.
// Found without the model writing anything: the same stand-in as notes.mjs, with this model's own token counts.
const MODE = 'call, names shown'
async function overshoot(m) {
  let worst = 0
  const llm = {
    contextSize, count: async (texts) => engine.count(texts),
    chat: async (prompt, _onToken, o = {}) => { worst = Math.max(worst, (engine.count([prompt])[0] + (o.maxTokens ?? 0)) / contextSize); return o.summary ? `### 议题\n${'- 讨论了项目进度和下一步安排，确认了负责人和时间。\n'.repeat(16)}` : '## 摘要\n- 要点\n\n## 下一步\n- **You:** 跟进\n' },
  }
  await builds.upstream.enhance({ meeting: { title: '', attendees: [] }, mine: '', segments: segmentsOf(m, MODE), language: 'zh' }, llm, () => {})
  return worst
}
let meeting = meetings[0], most = 0
for (const m of meetings) { const w = await overshoot(m); if (w > most) { most = w; meeting = m } }
const segments = segmentsOf(meeting, MODE)
console.error(`pipeline meeting: ${meeting.id}, upstream's worst prompt is ${most.toFixed(2)} contexts`)

// ---- 1. where is it cut ----------------------------------------------------------------------------------------
const PASSWORDS = ['青龙七号', '白虎三号', '朱雀九号']
async function passwords(name, lines) {
  const at = [0.05, 0.5, 0.95].map((p) => Math.floor(lines.length * p))
  const withThem = lines.flatMap((l, i) => (at.includes(i) ? [l, `Them: 记一下，暗号是「${PASSWORDS[at.indexOf(i)]}」。`] : [l]))
  const prompt = `下面是一场会议的转写。\n<transcript>\n${withThem.join('\n')}\n</transcript>\n\n转写里一共提到了哪几个暗号？只列出暗号，一行一个，不要写别的。`
  const row = { case: name, promptTokens: engine.count([prompt])[0], contextSize }
  const t = performance.now()
  try {
    const answer = await engine.chat({ messages: [{ role: 'user', content: prompt }], maxTokens: 120, thoughtBudget: 0, temperature: 0 }, () => {}, undefined, (timing) => { row.tokensRead = readOf(timing) })
    kept[`passwords: ${name}`] = answer
    row.listed = { start: answer.includes(PASSWORDS[0]), middle: answer.includes(PASSWORDS[1]), end: answer.includes(PASSWORDS[2]) }
  } catch (e) { row.error = String(e?.message ?? e).slice(0, 300) }
  row.seconds = Math.round((performance.now() - t) / 1000)
  out.passwords.push(row); save()
  console.error(JSON.stringify(row))
}
// a transcript that fits: the meeting's first turns, up to about half the context
let n = 0, size = 0
while (n < turns.length && size + engine.count([turns[n]])[0] < contextSize * 0.55) size += engine.count([turns[n++]])[0] + 1
await passwords('fits', turns.slice(0, n))
await passwords('does not fit', turns)

// ---- 2. the notes pipeline -------------------------------------------------------------------------------------
for (const [name, build] of Object.entries(builds)) {
  const calls = []
  const llm = {
    contextSize,
    count: async (texts) => engine.count(texts),
    chat: async (prompt, onToken, o = {}) => {
      const messages = [...(o.before ?? []).map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })), { role: 'user', content: prompt }]
      const call = { kind: o.summary ? 'part' : 'notes', promptTokens: engine.count([prompt])[0], roomForAnswer: o.maxTokens ?? 0 }
      call.fits = call.promptTokens + call.roomForAnswer <= contextSize
      calls.push(call)
      const t = performance.now()
      try {
        const text = await engine.chat({ messages, ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}), thoughtBudget: 0, ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) }, onToken, undefined, (timing) => { call.tokensRead = readOf(timing); call.timing = timing })
        call.answerCharacters = text.length
        // a part's summary is asked for as "- " bullets under "### " topic lines and nothing else
        if (o.summary) { call.answerStartsAsAsked = /^\s*(###\s|-\s)/.test(text); call.answerHasIntroductionOrClosing = /^[^#\-\s]/.test(text.trim()) || /总结/.test(text.slice(-200)) }
        kept[`${name}: ${call.kind} ${calls.length}`] = text
        return text
      } catch (e) { call.error = String(e?.message ?? e).slice(0, 300); throw e } finally { call.seconds = Math.round((performance.now() - t) / 1000); save(); console.error(name, JSON.stringify(call)) }
    },
  }
  const row = { build: name, meeting: `AISHELL-4 test, ${meeting.id}, heard as a call with names shown`, transcriptTokens: build.transcriptText(segments).split('\n').reduce((s, l) => s + engine.count([l])[0] + 1, 0), calls }
  out.pipeline.push(row)
  const t = performance.now()
  try { row.notesCharacters = (await build.enhance({ meeting: { title: '', attendees: [] }, mine: '', segments, language: 'zh' }, llm, () => {})).length } catch (e) { row.failed = String(e?.message ?? e).slice(0, 300) }
  row.seconds = Math.round((performance.now() - t) / 1000)
  save()
}
await engine.unload()
console.log(JSON.stringify(out, null, 1))
process.exit(0)
