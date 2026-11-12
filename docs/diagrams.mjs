// Draws the README's two diagrams as SVG pictures, in English and Chinese:
//   node docs/diagrams.mjs   → docs/assets/how-it-works(.zh-CN).svg and long-meeting(.zh-CN).svg
// They are pictures and not Mermaid blocks because GitHub measures a Mermaid label with one font and draws it with
// another, which cut the labels off. Here every box is sized from its own text, with room to spare.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), 'assets')
const W = 860, FONT = 13, LINE = 18
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
/** how wide a line is drawn, on the generous side: a full-width letter a little over the font size, any other a little over half */
const wide = (s) => [...s].reduce((n, ch) => n + (/[⺀-鿿가-힯＀-￯]/.test(ch) ? FONT + 1.5 : FONT * 0.6), 0)

/** a box around its lines, centred on (cx, cy). kind: step, ask (a question, six-sided), start (rounded ends), away (off this computer, dashed) */
function box(cx, cy, lines, kind = 'step') {
  const w = Math.ceil(Math.max(...lines.map(wide)) + (kind === 'ask' ? 64 : 40)), h = lines.length * LINE + 22
  const x = cx - w / 2, y = cy - h / 2
  const shape = kind === 'ask'
    ? `<path d="M${x + 16} ${y}H${x + w - 16}L${x + w} ${cy}L${x + w - 16} ${y + h}H${x + 16}L${x} ${cy}Z" class="ask"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${kind === 'start' ? h / 2 : 8}" class="${kind}"/>`
  const text = lines.map((l, i) => `<text x="${cx}" y="${cy - ((lines.length - 1) * LINE) / 2 + i * LINE + 4.5}" text-anchor="middle" class="label">${esc(l)}</text>`).join('')
  return { svg: shape + text, cx, cy, top: y, bottom: y + h, left: x, right: x + w }
}
/** a line through the points, with an arrowhead at its end; dashed when it leaves the computer */
const arrow = (points, dashed = false) => `<path d="M${points.map((p) => p.join(' ')).join('L')}" class="${dashed ? 'line away-line' : 'line'}" marker-end="url(#head)"/>`
/** a word on a line, on a patch of the surface so the line does not run through it */
const tag = (x, y, s) => { const w = wide(s) + 12; return `<rect x="${x - w / 2}" y="${y - 10}" width="${w}" height="20" rx="4" class="patch"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="tag">${esc(s)}</text>` }

const page = (h, title, desc, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
  text { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
  .surface { fill: #fcfcfb; stroke: rgba(11,11,11,0.10); }
  .zone { fill: #f4f4f1; stroke: #e1e0d9; }
  .zone-name { font-size: 12px; font-weight: 600; fill: #52514e; }
  .label { font-size: ${FONT}px; fill: #0b0b0b; }
  .tag { font-size: 12px; fill: #52514e; }
  .patch { fill: #fcfcfb; }
  .zone-patch { fill: #f4f4f1; }
  .step, .start { fill: #ffffff; stroke: #c3c2b7; }
  .ask { fill: #e6f0fc; stroke: #86b6ef; }
  .away { fill: #ffffff; stroke: #898781; stroke-dasharray: 5 4; }
  .line { fill: none; stroke: #52514e; stroke-width: 1.5; stroke-linejoin: round; }
  .away-line { stroke-dasharray: 5 4; }
  .head { fill: #52514e; }
  @media (prefers-color-scheme: dark) {
    .surface, .patch { fill: #1a1a19; }
    .surface { stroke: rgba(255,255,255,0.10); }
    .zone, .zone-patch { fill: #232322; }
    .zone { stroke: #383835; }
    .zone-name, .tag { fill: #c3c2b7; }
    .label { fill: #f0efec; }
    .step, .start, .away { fill: #2c2c2a; stroke: #52514e; }
    .away { stroke: #898781; }
    .ask { fill: #17335a; stroke: #3987e5; }
    .line { stroke: #c3c2b7; }
    .head { fill: #c3c2b7; }
  }
</style>
<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="head"/></marker></defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="12" class="surface"/>
${body}
</svg>
`

/** How it works: what happens to a meeting, top to bottom, all on this computer; the cloud model is the one way out */
function pipeline(t) {
  const x = 300, gap = 72
  const steps = t.steps.map((lines, i) => box(x, 96 + i * gap, lines, i === 0 ? 'start' : 'step'))
  const [, , , , parts, , notes] = steps
  const cloud = box(700, (parts.cy + notes.cy) / 2, t.cloud, 'away')
  const bottom = steps.at(-1).bottom + 28
  const body = [
    `<rect x="40" y="36" width="520" height="${bottom - 36}" rx="10" class="zone"/>`,
    `<text x="58" y="60" class="zone-name">${esc(t.zone)}</text>`,
    ...steps.slice(1).map((s, i) => arrow([[x, steps[i].bottom], [x, s.top - 2]])),
    arrow([[parts.right, parts.cy], [cloud.cx, parts.cy], [cloud.cx, cloud.top - 2]], true),
    arrow([[cloud.cx, cloud.bottom], [cloud.cx, notes.cy], [notes.right + 2, notes.cy]], true),
    ...steps.map((s) => s.svg), cloud.svg,
  ].join('\n')
  return page(bottom + 28, t.title, t.desc, body)
}

/** How a long meeting is read: counted, cut if it has to be, counted again, and only then sent */
function longMeeting(t) {
  const L = 130, M = 470, R = 730
  const start = box(M, 60, t.transcript, 'start')
  const fits = box(M, 142, t.fits, 'ask')
  const cut = box(M, 232, t.cut)
  const long = box(M, 314, t.long, 'ask')
  const check = box(M, 502, t.check, 'ask')
  // "no" runs straight down on the right, inside both six-sided boxes; the step for "yes" sits clear of it on the left
  const noX = Math.min(long.right, check.right) - 30
  const probe = box(0, 0, t.inside), half = (probe.right - probe.left) / 2
  const inside = box(Math.min(M - 60, noX - 34 - half), 408, t.inside)
  const yesX = Math.max(inside.cx, long.left + 26), downX = Math.max(inside.cx, check.left + 26)
  const sum = box(M, 590, t.sum)
  const merged = box(M, 666, t.merged)
  const whole = box(L, 666, t.whole)
  const notes = box((L + M) / 2, 760, t.notes)
  const body = [
    arrow([[M, start.bottom], [M, fits.top - 2]]),
    // it fits: the whole meeting goes in one prompt
    arrow([[fits.left, fits.cy], [L, fits.cy], [L, whole.top - 2]]),
    tag(L, 380, t.yes),
    arrow([[M, fits.bottom], [M, cut.top - 2]]),
    tag(M, (fits.bottom + cut.top) / 2 - 1, t.no),
    arrow([[M, cut.bottom], [M, long.top - 2]]),
    // a turn longer than a part is cut inside; otherwise straight on to the count
    arrow([[yesX, long.bottom], [yesX, inside.top - 2]]),
    tag(yesX, (long.bottom + inside.top) / 2 - 1, t.yes),
    arrow([[noX, long.bottom], [noX, check.top - 2]]),
    tag(noX, inside.cy, t.no),
    arrow([[downX, inside.bottom], [downX, check.top - 2]]),
    // a part too big: all are cut again, with less room
    arrow([[check.right, check.cy], [R, check.cy], [R, cut.cy], [cut.right + 2, cut.cy]]),
    tag(R, (check.cy + cut.cy) / 2, t.again),
    arrow([[M, check.bottom], [M, sum.top - 2]]),
    tag(M, (check.bottom + sum.top) / 2 - 1, t.yes),
    arrow([[M, sum.bottom], [M, merged.top - 2]]),
    arrow([[L, whole.bottom], [L, notes.cy], [notes.left - 2, notes.cy]]),
    arrow([[M, merged.bottom], [M, notes.cy], [notes.right + 2, notes.cy]]),
    start.svg, fits.svg, cut.svg, long.svg, inside.svg, check.svg, sum.svg, merged.svg, whole.svg, notes.svg,
  ].join('\n')
  return page(816, t.title, t.desc, body)
}

const TEXT = {
  en: {
    tail: '',
    pipeline: {
      title: 'How a meeting becomes notes',
      desc: 'On your computer: microphone and call audio, recorder, whisper.cpp speech to text, transcript and notes in SQLite, the notes pipeline, the notes model, then the Summary, titles and answers. The one way out is a service you choose, only while Cloud AI is on.',
      zone: 'Your computer',
      steps: [['Microphone and call audio'], ['Recorder'], ['whisper.cpp: speech to text'], ['Transcript and notes, SQLite'], ['Notes pipeline:', 'parts sized by the model’s tokenizer'], ['Notes model, llama.cpp'], ['Summary, titles, answers']],
      cloud: ['A service you choose', 'only while Cloud AI is on'],
    },
    long: {
      title: 'How a long meeting is read',
      desc: 'The transcript is counted by the tokenizer. If it fits, the whole meeting is one prompt. If not, it is cut into parts between turns; a turn longer than a part is cut between sentences, then words; every part is counted again and cut again with less room until all fit; each part is summarised and the summaries make one prompt. The notes model then writes the Summary.',
      transcript: ['Transcript, one line a turn'],
      fits: ['Counted by the tokenizer: does it fit,', 'with room for the notes?'],
      cut: ['Cut into parts between turns'],
      long: ['Is one turn longer than a part?'],
      inside: ['Cut it between sentences, then words.', 'Each piece gets its share', 'of the turn’s real size'],
      check: ['Every part counted again:', 'do they all fit?'],
      sum: ['Each part summarised'],
      merged: ['One prompt: the summaries, in order'],
      whole: ['One prompt:', 'the whole meeting'],
      notes: ['The notes model writes the Summary'],
      yes: 'yes', no: 'no', again: 'no: less room, cut again',
    },
  },
  zh: {
    tail: '.zh-CN',
    pipeline: {
      title: '一场会议怎么变成纪要',
      desc: '都在你的电脑上：麦克风和通话里的声音、录音、whisper.cpp 语音转文字、存进 SQLite 的文字记录和笔记、纪要流程、纪要模型，最后是摘要、标题和回答。唯一向外的一条路是你选的服务，只在云端 AI 打开期间。',
      zone: '你的电脑',
      steps: [['麦克风和通话里的声音'], ['录音'], ['whisper.cpp：语音转文字'], ['文字记录和笔记，SQLite'], ['纪要流程：', '按模型的分词器量好每一段'], ['纪要模型，llama.cpp'], ['摘要、标题、回答']],
      cloud: ['你选的服务', '只在云端 AI 打开期间'],
    },
    long: {
      title: '很长的会议是怎么读完的',
      desc: '文字记录先用分词器数一遍。放得下，整场会议就是一个提示词。放不下，就在两段话之间切成几段；一段话本身比一段还长，就先在句子之间、再在词之间切；每一段再数一遍，有超出的就留小一点重新切，直到都放得下；每段写一份小结，小结按顺序排成一个提示词。最后纪要模型写出摘要。',
      transcript: ['文字记录，一人一段话为一行'],
      fits: ['用分词器数过：', '留出写纪要的空间后放得下吗？'],
      cut: ['在两段话之间切成几段'],
      long: ['有一段话本身比一段还长吗？'],
      inside: ['先在句子之间切，再在词之间切。', '每一小块按比例', '分到这段话的真实大小'],
      check: ['每一段再数一遍：', '都放得下吗？'],
      sum: ['每段写一份小结'],
      merged: ['一个提示词：按顺序排好的小结'],
      whole: ['一个提示词：', '整场会议'],
      notes: ['纪要模型写出摘要'],
      yes: '是', no: '否', again: '否：留小一点，重新切',
    },
  },
}

mkdirSync(out, { recursive: true })
for (const t of Object.values(TEXT)) {
  writeFileSync(join(out, `how-it-works${t.tail}.svg`), pipeline(t.pipeline))
  writeFileSync(join(out, `long-meeting${t.tail}.svg`), longMeeting(t.long))
  console.log('wrote', `docs/assets/how-it-works${t.tail}.svg`, 'and', `docs/assets/long-meeting${t.tail}.svg`)
}
