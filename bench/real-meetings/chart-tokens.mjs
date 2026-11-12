// Draws the README's second chart from results-tokens.json: what a character really costs in tokens, by the app's
// own tokenizers, against the third of a token the notes code used to guess for any character.
//   node bench/real-meetings/chart-tokens.mjs   → docs/assets/tokens-per-character.svg and tokens-per-character.zh-CN.svg
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../docs/assets')
const { results } = JSON.parse(readFileSync(join(here, 'results-tokens.json'), 'utf8'))

const GUESS = 1 / 3
const SETS = ['AISHELL-4 test', 'VCSum', 'QMSum (AMI + ICSI)']
const TOKENIZERS = ['Gemma 4 E4B', 'Qwen3 1.7B']
const row = (set, tokenizer) => {
  const found = results.filter((r) => r.set === set && r.tokenizer === tokenizer)
  if (found.length !== 1) throw new Error(`${found.length} rows for ${set} / ${tokenizer}`)
  return found[0]
}
// the sentence under the title says Chinese costs about twice the guess and English less than it: checked here
for (const t of TOKENIZERS) {
  for (const set of SETS.slice(0, 2)) if (!(row(set, t).tokensPerCharacter > GUESS * 1.6)) throw new Error(`${set} is no longer far above the guess`)
  if (!(row(SETS[2], t).tokensPerCharacter < GUESS)) throw new Error('English is no longer under the guess')
}

const TEXT = {
  en: {
    file: 'tokens-per-character.svg',
    title: 'What one character costs the notes model, in tokens',
    sub: ['Counted by the app’s own tokenizers over every line of 455 meeting transcripts',
      'A Chinese character costs about twice the old guess; an English one, less than it'],
    sets: { 'AISHELL-4 test': 'Mandarin · AISHELL-4', VCSum: 'Mandarin · VCSum', 'QMSum (AMI + ICSI)': 'English · QMSum' },
    guess: 'the old guess: 1/3', axis: 'tokens a character',
    foot: ['A guess that is too low makes a meeting look smaller than it is, so too much of it is sent at once. All figures: bench/real-meetings.'],
    desc: 'Horizontal bars of tokens a character, against a guess of one third:',
  },
  zh: {
    file: 'tokens-per-character.zh-CN.svg',
    title: '一个字符对纪要模型来说是多少 token',
    sub: ['用应用自己的分词器，数了 455 场会议文字记录的每一行',
      '一个汉字大约是原来估计值的两倍；英文字符比估计值还少'],
    sets: { 'AISHELL-4 test': '中文 · AISHELL-4', VCSum: '中文 · VCSum', 'QMSum (AMI + ICSI)': '英文 · QMSum' },
    guess: '原来的估计：1/3', axis: '每个字符的 token 数',
    foot: ['估得偏低，会议看起来就比实际小，一次送给模型的内容就会过多。全部数字见 bench/real-meetings。'],
    desc: '横向条形图，每个字符的 token 数，对比估计值三分之一：',
  },
}

const W = 860, PAD = 28, BAR_X = 262, BAR_W = 460, MAX = 0.8, ROW = 30, BAR_H = 12
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const n = (v) => Number(v.toFixed(1))
const bar = (x, y, w) => `M${x} ${y}h${n(w - 4)}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1 -4 4h${n(4 - w)}z`

function draw(t) {
  const head = [], rows = [], bands = [], said = []
  let y = 40
  head.push(`<text x="${PAD}" y="${y}" class="title">${esc(t.title)}</text>`)
  for (const s of t.sub) { y += 19; head.push(`<text x="${PAD}" y="${y}" class="sub">${esc(s)}</text>`) }
  y += 26
  const labelY = y
  for (const set of SETS) {
    y += 26
    rows.push(`<text x="${PAD}" y="${y}" class="group">${esc(t.sets[set])}</text>`)
    y += 8
    const top = y
    for (const tokenizer of TOKENIZERS) {
      const v = row(set, tokenizer).tokensPerCharacter, w = (v / MAX) * BAR_W, mid = y + ROW / 2
      rows.push(`<text x="${PAD + 10}" y="${mid + 4}" class="label">${esc(tokenizer)}</text>`,
        `<path d="${bar(BAR_X, mid - BAR_H / 2, w)}" class="bar"/>`,
        `<text x="${n(BAR_X + w + 8)}" y="${mid + 4}" class="value">${v.toFixed(2)}</text>`)
      said.push(`${set}, ${tokenizer}: ${v.toFixed(2)}`)
      y += ROW
    }
    bands.push([top, y])
  }
  const bottom = y + 6
  const lines = (x, kind) => bands.map(([a, z]) => `<path d="M${x} ${a}V${z}" class="${kind}"/>`).join('')
  const grid = [0, 0.2, 0.4, 0.6, 0.8].map((v) => {
    const x = n(BAR_X + (v / MAX) * BAR_W)
    return `${lines(x, v ? 'grid' : 'base')}<text x="${x}" y="${bottom + 16}" class="tick" text-anchor="middle">${v === 0 ? '0' : v.toFixed(1)}</text>`
  })
  // the guess: one line down the whole plot, named at its top
  const gx = n(BAR_X + (GUESS / MAX) * BAR_W)
  const guess = `<path d="M${gx} ${labelY + 8}V${bottom}" class="guess"/><text x="${gx}" y="${labelY}" class="head" text-anchor="middle">${esc(t.guess)}</text>`
  y = bottom + 34
  grid.push(`<text x="${BAR_X + BAR_W / 2}" y="${y}" class="tick" text-anchor="middle">${esc(t.axis)}</text>`)
  const foot = t.foot.map((s) => { y += 19; return `<text x="${PAD}" y="${y}" class="foot">${esc(s)}</text>` })
  const H = y + 22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(t.title)}</title>
<desc id="d">${esc(`${t.desc} ${said.join('; ')}.`)}</desc>
<style>
  text { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
  .surface { fill: #fcfcfb; stroke: rgba(11,11,11,0.10); }
  .title { font-size: 17px; font-weight: 600; fill: #0b0b0b; }
  .sub, .label { font-size: 12.5px; fill: #52514e; }
  .group { font-size: 12.5px; font-weight: 600; fill: #0b0b0b; }
  .head { font-size: 12px; font-weight: 600; fill: #52514e; }
  .value { font-size: 12px; fill: #0b0b0b; font-variant-numeric: tabular-nums; }
  .tick, .foot { font-size: 11.5px; fill: #898781; }
  .bar { fill: #2a78d6; }
  .grid { stroke: #e1e0d9; stroke-width: 1; fill: none; }
  .base { stroke: #c3c2b7; stroke-width: 1; fill: none; }
  .guess { stroke: #52514e; stroke-width: 1.5; fill: none; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19; stroke: rgba(255,255,255,0.10); }
    .title, .group, .value { fill: #f0efec; }
    .sub, .label, .head { fill: #c3c2b7; }
    .bar { fill: #3987e5; }
    .grid { stroke: #2c2c2a; }
    .base { stroke: #383835; }
    .guess { stroke: #c3c2b7; }
  }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" class="surface"/>
${grid.join('\n')}
${head.join('\n')}
${rows.join('\n')}
${guess}
${foot.join('\n')}
</svg>
`
}

mkdirSync(out, { recursive: true })
for (const t of Object.values(TEXT)) {
  writeFileSync(join(out, t.file), draw(t))
  console.log('wrote', join('docs/assets', t.file))
}
