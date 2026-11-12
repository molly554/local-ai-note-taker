// Real meetings through the notes pipeline, before (upstream) and after (this fork).
//   node bench/real-meetings/fetch.mjs     once: about 26 MB of public transcripts into data/
//   node bench/real-meetings/notes.mjs     Node 24+; nothing to install; about a minute
// It runs the app's own enhance() on each meeting, with a stand-in for the model that writes nothing and records the
// prompts it was sent. What is measured: is every prompt small enough for the model's context, how many parts a long
// meeting is read in, and whether any of the transcript went missing on the way.
// No model runs here, so token counts come from a stand-in tokenizer (standIn below): the sizes are estimates.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aishell4, here, qmsum, useAppSource, vcsum } from './meetings.mjs'

useAppSource()
const builds = { upstream: await import('./upstream/enhance.ts'), fork: await import('../../app/src/main/notes/enhance.ts') }

const SETS = [
  { set: 'AISHELL-4 test', lang: 'zh', meetings: aishell4() },
  { set: 'VCSum', lang: 'zh', meetings: vcsum() },
  { set: 'QMSum (AMI + ICSI)', lang: 'en', meetings: qmsum() },
]

// ---- how the app would have heard them ------------------------------------------------------------------------
// The app knows two voices for sure: the microphone ("You") and the computer's sound (a name when the call app shows
// who is talking, "Them" otherwise). A room recorded on one microphone is all "You". The meeting's first speaker
// stands in for the person recording.
const MODES = {
  'call, names shown': (l, me) => (l.speaker === me ? { track: 'me', speaker: null } : { track: 'them', speaker: l.speaker }),
  'call, no names': (l, me) => ({ track: l.speaker === me ? 'me' : 'them', speaker: null }),
  'one microphone': () => ({ track: 'me', speaker: null }),
}
const segmentsOf = (m, mode) => m.lines.map((l, i) => ({ id: i, meetingId: m.id, startMs: l.startMs, endMs: l.endMs, text: l.text, ...MODES[mode](l, m.lines[0].speaker) }))

// ---- the stand-in model ---------------------------------------------------------------------------------------
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
/** tokens in a text: perCjk for each Chinese, Japanese or Korean letter, one for every four other characters */
const standIn = (perCjk) => (s) => { const c = s.match(CJK)?.length ?? 0; return Math.ceil(c * perCjk + (s.length - c) / 4) }
const SUMMARY = { zh: `### 议题\n${'- 讨论了项目进度和下一步安排，确认了负责人和时间。\n'.repeat(16)}`, en: `### Topic\n${'- Discussed the schedule and the next steps, and agreed who does what by when.\n'.repeat(20)}` }
const NOTES = { zh: '## 摘要\n- 要点\n\n## 下一步\n- **You:** 跟进\n', en: '## Summary\n- Point\n\n## Next steps\n- **You:** follow up\n' }
/** a transcript without who spoke and without spaces, to compare what went in with what reached the model */
const bare = (t) => t.split('\n').map((l) => l.replace(/^[^:]{1,60}: /, '')).join('').replace(/\s+/g, '')
const wordsOnly = (t) => t.replace(/[^\p{L}\p{N}]+/gu, '')

async function one(build, segments, lang, contextSize, count) {
  const calls = []
  let firstRound = 0
  const llm = {
    contextSize,
    count: async (texts) => texts.map(count),
    chat: async (prompt, _onToken, o = {}) => {
      const tokens = count(prompt) + (o.before ?? []).reduce((a, b) => a + count(b), 0)
      calls.push({ part: !!o.summary, tokens, room: o.maxTokens ?? 0, piece: o.summary ? prompt.slice(prompt.indexOf('<transcript>\n') + 13, prompt.lastIndexOf('\n</transcript>')) : '' })
      return o.summary ? SUMMARY[lang] : NOTES[lang]
    },
  }
  await build.enhance({ meeting: { title: '', attendees: [] }, mine: '', segments, language: lang }, llm, () => {}, (_n, of) => { firstRound ||= of })
  const r = { parts: firstRound, fewest: 0, over: calls.filter((c) => c.tokens + c.room > contextSize).length, worst: Math.max(...calls.map((c) => (c.tokens + c.room) / contextSize)), dropped: 0, wordsLost: false }
  if (firstRound) {
    const transcript = build.transcriptText(segments)
    // the fewest parts that could hold it: the transcript's tokens over the most one part may hold
    r.fewest = Math.ceil(transcript.split('\n').reduce((n, l) => n + count(l) + 1, 0) / await build.partBudget(llm, build.languageName(lang)))
    const went = bare(transcript), arrived = bare(calls.filter((c) => c.part).slice(0, firstRound).map((c) => c.piece).join('\n'))
    r.dropped = went.length - arrived.length
    r.wordsLost = wordsOnly(went) !== wordsOnly(arrived)
    if (process.env.SHOW_DROPPED && r.dropped) {
      let i = 0
      while (went[i] === arrived[i]) i++
      console.error(`dropped ${r.dropped} | went: ${JSON.stringify(went.slice(Math.max(0, i - 40), i + 20))} | arrived: ${JSON.stringify(arrived.slice(Math.max(0, i - 40), i + 20))}`)
      delete process.env.SHOW_DROPPED
    }
  }
  return r
}

// ---- run -------------------------------------------------------------------------------------------------------
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const characters = (m) => m.lines.reduce((n, l) => n + l.text.length, 0)
const longestTurn = (m, mode) => Math.max(...builds.fork.transcriptText(segmentsOf(m, mode)).split('\n').map((t) => t.length))
const about = SETS.map(({ set, lang, meetings }) => ({
  set, lang, meetings: meetings.length, lines: meetings.reduce((n, m) => n + m.lines.length, 0),
  medianCharacters: median(meetings.map(characters)), mostCharacters: Math.max(...meetings.map(characters)),
  longestTurnCharacters: Object.fromEntries(Object.keys(MODES).map((mode) => [mode, { median: median(meetings.map((m) => longestTurn(m, mode))), most: Math.max(...meetings.map((m) => longestTurn(m, mode))) }])),
}))

const results = []
const started = performance.now()
for (const { set, lang, meetings } of SETS) {
  for (const perCjk of lang === 'zh' ? [1, 0.7] : [1]) {
    const count = standIn(perCjk)
    for (const contextSize of [32_768, 8192]) for (const mode of Object.keys(MODES)) for (const [name, build] of Object.entries(builds)) {
      const row = { set, mode, contextSize, tokensPerCjkLetter: lang === 'zh' ? perCjk : null, build: name, meetings: meetings.length, readWhole: 0, readInParts: 0, parts: 0, fewestPartsThatFit: 0, promptsThatDoNotFit: 0, meetingsWithOne: 0, worstTimesContext: 0, meetingsWithWordsLost: 0, meetingsWithMarksDropped: 0, marksDropped: 0 }
      for (const m of meetings) {
        const r = await one(build, segmentsOf(m, mode), lang, contextSize, count)
        if (r.parts) { row.readInParts++; row.parts += r.parts; row.fewestPartsThatFit += r.fewest } else row.readWhole++
        row.promptsThatDoNotFit += r.over
        if (r.over) row.meetingsWithOne++
        if (r.wordsLost) row.meetingsWithWordsLost++
        if (r.dropped) { row.meetingsWithMarksDropped++; row.marksDropped += r.dropped }
        row.worstTimesContext = Math.max(row.worstTimesContext, r.worst)
      }
      row.worstTimesContext = +row.worstTimesContext.toFixed(2)
      results.push(row)
      console.error(`${set} | ${mode} | ${contextSize} | ${perCjk} | ${name}`)
    }
  }
}

console.log('| meetings | heard as | context | tokens per CJK letter | build | read whole | read in parts | parts (fewest that fit) | meetings with a prompt that does not fit | worst prompt (x context) | meetings with words lost | punctuation marks dropped |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) console.log(`| ${r.set} (${r.meetings}) | ${r.mode} | ${r.contextSize.toLocaleString('en')} | ${r.tokensPerCjkLetter ?? '-'} | ${r.build} | ${r.readWhole} | ${r.readInParts} | ${r.parts} (${r.fewestPartsThatFit}) | ${r.meetingsWithOne} | ${r.worstTimesContext} | ${r.meetingsWithWordsLost} | ${r.marksDropped} |`)
writeFileSync(join(here, 'results-notes.json'), JSON.stringify({ node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10), seconds: Math.round((performance.now() - started) / 1000), about, results }, null, 1) + '\n')
