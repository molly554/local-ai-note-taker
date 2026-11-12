// Draws the README's chart from results-notes-models.json, so the picture can only say what the run said:
//   node bench/real-meetings/chart.mjs      → docs/assets/overflow-8192.svg and overflow-8192.zh-CN.svg
// One bar a row: the share of a set's meetings where the pipeline as it was (upstream/enhance.ts) sent the model a prompt that does not fit a context of
// 8,192 tokens, counted with Gemma 4 E4B's tokenizer (the starter notes model). Today's count is printed beside it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../docs/assets')
const { results } = JSON.parse(readFileSync(join(here, 'results-notes-models.json'), 'utf8'))

const CONTEXT = 8192, TOKENIZER = 'Gemma 4 E4B'
const SETS = ['AISHELL-4 test', 'VCSum']
const MODES = ['call, names shown', 'call, no names', 'one microphone', 'one microphone, no punctuation']
const row = (set, mode, build) => {
  const found = results.filter((r) => r.set === set && r.mode === mode && r.build === build && r.contextSize === CONTEXT && r.tokenizer === TOKENIZER)
  if (found.length !== 1) throw new Error(`${found.length} rows for ${set} / ${mode} / ${build}`)
  return found[0]
}
// English was never at risk: said in the subtitle, and checked here so the sentence stays true
const english = results.filter((r) => r.set.startsWith('QMSum') && r.contextSize === CONTEXT)
if (!english.length || english.some((r) => r.meetingsWithOne !== 0)) throw new Error('an English meeting has a prompt that does not fit: the subtitle is wrong')
const englishMeetings = english[0].meetings

const TEXT = {
  en: {
    file: 'overflow-8192.svg',
    title: 'Meetings where the notes model is sent more than it can read',
    sub: [`Context of 8,192 tokens (what the app takes when memory is short) · counted with the ${TOKENIZER} tokenizer`,
      `The notes pipeline before these changes against now · English meetings (QMSum, ${englishMeetings}): 0 either way`],
    upstream: 'Before', fork: 'Now', axis: 'share of the set’s meetings',
    sets: { 'AISHELL-4 test': (n) => `AISHELL-4 · ${n} Mandarin meetings of 4 to 8 people`, VCSum: (n) => `VCSum · ${n} Mandarin round-table meetings` },
    modes: { 'call, names shown': 'Call, names shown', 'call, no names': 'Call, no names', 'one microphone': 'One microphone', 'one microphone, no punctuation': 'One microphone, no punctuation*' },
    of: (a, b) => `${a} of ${b}`,
    foot: ['* The same text with every punctuation mark removed, as speech to text may leave Chinese; not in the corpora.',
      'At the 32,768 tokens the app asks for, every prompt fits either way. Method and all figures: bench/real-meetings.'],
    desc: 'Horizontal bars. Before the changes, a prompt that does not fit was sent in',
  },
  zh: {
    file: 'overflow-8192.zh-CN.svg',
    title: '送给纪要模型的内容超出它一次能读的量：有多少场会议',
    sub: [`上下文 8,192 token（内存不够时应用实际拿到的大小）· 用 ${TOKENIZER} 的分词器计数`,
      `纪要流程改之前对比现在 · 英文会议（QMSum，${englishMeetings} 场）：两边都是 0`],
    upstream: '改之前', fork: '现在', axis: '占该语料会议数的比例',
    sets: { 'AISHELL-4 test': (n) => `AISHELL-4 · ${n} 场 4 到 8 人的中文会议`, VCSum: (n) => `VCSum · ${n} 场中文圆桌会议` },
    modes: { 'call, names shown': '通话，显示说话人名字', 'call, no names': '通话，不显示名字', 'one microphone': '一个麦克风', 'one microphone, no punctuation': '一个麦克风，没有标点*' },
    of: (a, b) => `${a} / ${b} 场`,
    foot: ['* 同一份文字去掉全部标点，模拟语音转文字不给中文加标点的情况；语料里本来没有这一种。',
      '上下文是应用默认要的 32,768 token 时，改之前和现在的提示词都放得下。方法和全部数字见 bench/real-meetings。'],
    desc: '横向条形图。改之前发出放不下的提示词的会议数：',
  },
}

const W = 860, PAD = 28, BAR_X = 262, BAR_W = 380, FORK_X = 776, ROW = 30, BAR_H = 12
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const n = (v) => Number(v.toFixed(1))
/** a bar growing right from x: square at the baseline, 4px rounded at the data end */
const bar = (x, y, w) => w < 4 ? `M${x} ${y}h${n(w)}v${BAR_H}h${n(-w)}z` : `M${x} ${y}h${n(w - 4)}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1 -4 4h${n(4 - w)}z`

function draw(t) {
  const parts = [], said = []
  let y = 40
  parts.push(`<text x="${PAD}" y="${y}" class="title">${esc(t.title)}</text>`)
  for (const s of t.sub) { y += 19; parts.push(`<text x="${PAD}" y="${y}" class="sub">${esc(s)}</text>`) }
  y += 30
  parts.push(`<text x="${BAR_X}" y="${y}" class="head">${esc(t.upstream)}</text>`, `<text x="${FORK_X}" y="${y}" class="head" text-anchor="middle">${esc(t.fork)}</text>`)
  const rows = [], bands = []
  for (const set of SETS) {
    y += 30
    const meetings = row(set, MODES[0], 'upstream').meetings
    rows.push(`<text x="${PAD}" y="${y}" class="group">${esc(t.sets[set](meetings))}</text>`)
    y += 8
    const top = y
    for (const mode of MODES) {
      const up = row(set, mode, 'upstream'), fork = row(set, mode, 'fork')
      if (fork.meetingsWithOne !== 0) throw new Error(`the fork has ${fork.meetingsWithOne} in ${set} / ${mode}: the chart's point no longer holds`)
      const w = (up.meetingsWithOne / up.meetings) * BAR_W, mid = y + ROW / 2
      rows.push(`<text x="${PAD + 10}" y="${mid + 4}" class="label">${esc(t.modes[mode])}</text>`,
        `<path d="${bar(BAR_X, mid - BAR_H / 2, w)}" class="bar"/>`,
        `<text x="${n(BAR_X + w + 8)}" y="${mid + 4}" class="value">${esc(t.of(up.meetingsWithOne, up.meetings))}</text>`,
        `<text x="${FORK_X}" y="${mid + 4}" class="zero" text-anchor="middle">${fork.meetingsWithOne}</text>`)
      said.push(`${set}, ${mode}: ${up.meetingsWithOne} of ${up.meetings}`)
      y += ROW
    }
    bands.push([top, y])
  }
  const gridBottom = y + 6
  // gridlines only behind the bars, so they never run through a set's heading
  const lines = (x, kind) => bands.map(([a, z]) => `<path d="M${x} ${a}V${z}" class="${kind}"/>`).join('')
  const grid = [0, 25, 50, 75, 100].map((p) => {
    const x = n(BAR_X + (p / 100) * BAR_W)
    return `${lines(x, p ? 'grid' : 'base')}<text x="${x}" y="${gridBottom + 16}" class="tick" text-anchor="middle">${p}%</text>`
  })
  y = gridBottom + 34
  grid.push(`<text x="${BAR_X + BAR_W / 2}" y="${y}" class="tick" text-anchor="middle">${esc(t.axis)}</text>`)
  // the line between the two columns
  const rule = lines(FORK_X - 60, 'grid')
  const foot = t.foot.map((s) => { y += 19; return `<text x="${PAD}" y="${y}" class="foot">${esc(s)}</text>` })
  const H = y + 22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(t.title)}</title>
<desc id="d">${esc(`${t.desc} ${said.join('; ')}. ${t.fork}: 0.`)}</desc>
<style>
  text { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
  .surface { fill: #fcfcfb; stroke: rgba(11,11,11,0.10); }
  .title { font-size: 17px; font-weight: 600; fill: #0b0b0b; }
  .sub, .label { font-size: 12.5px; fill: #52514e; }
  .group { font-size: 12.5px; font-weight: 600; fill: #0b0b0b; }
  .head { font-size: 12px; font-weight: 600; fill: #52514e; }
  .value { font-size: 12px; fill: #0b0b0b; font-variant-numeric: tabular-nums; }
  .zero { font-size: 14px; font-weight: 600; fill: #0b0b0b; }
  .tick, .foot { font-size: 11.5px; fill: #898781; }
  .bar { fill: #2a78d6; }
  .grid { stroke: #e1e0d9; stroke-width: 1; fill: none; }
  .base { stroke: #c3c2b7; stroke-width: 1; fill: none; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19; stroke: rgba(255,255,255,0.10); }
    .title, .group, .value, .zero { fill: #f0efec; }
    .sub, .label, .head { fill: #c3c2b7; }
    .bar { fill: #3987e5; }
    .grid { stroke: #2c2c2a; }
    .base { stroke: #383835; }
  }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" class="surface"/>
${grid.join('\n')}
${rule}
${parts.join('\n')}
${rows.join('\n')}
${foot.join('\n')}
</svg>
`
}

mkdirSync(out, { recursive: true })
for (const t of Object.values(TEXT)) {
  writeFileSync(join(out, t.file), draw(t))
  console.log('wrote', join('docs/assets', t.file))
}
