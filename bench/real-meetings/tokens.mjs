// How many tokens real meeting text is, by two of the app's tokenizers, against the two guesses the notes code makes
// for text the tokenizer has not counted: a third of a token a character (upstream), and one token a Chinese,
// Japanese or Korean letter plus a third of a token for every other character (this fork).
//   node bench/real-meetings/fetch.mjs --models     once: 2.2 GB
//   node bench/real-meetings/tokens.mjs             after pnpm install (it uses the app's node-llama-cpp)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aishell4, here, qmsum, useAppSource, vcsum } from './meetings.mjs'
import { realTokenizers } from './tokenizers.mjs'

useAppSource()
const { roughTokens } = await import('../../app/src/main/notes/enhance.ts')
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const SETS = [['AISHELL-4 test', aishell4()], ['VCSum', vcsum()], ['QMSum (AMI + ICSI)', qmsum()]]

const results = []
for (const t of await realTokenizers()) {
  for (const [set, meetings] of SETS) {
    let characters = 0, cjk = 0, tokens = 0, third = 0, byLetter = 0
    // tokens = a x CJK letters + b x other characters, fitted over the lines (least squares)
    let cc = 0, co = 0, oo = 0, ct = 0, ot = 0
    for (const m of meetings) for (const l of m.lines) {
      const c = l.text.match(CJK)?.length ?? 0, o = l.text.length - c, n = t.count(l.text)
      characters += l.text.length; cjk += c; tokens += n; third += Math.ceil(l.text.length / 3); byLetter += roughTokens(l.text)
      cc += c * c; co += c * o; oo += o * o; ct += c * n; ot += o * n
    }
    t.reset()
    const det = cc * oo - co * co
    results.push({
      tokenizer: t.name, set, lines: meetings.reduce((n, m) => n + m.lines.length, 0), characters, cjkLetters: cjk, tokens,
      tokensPerCharacter: +(tokens / characters).toFixed(3),
      tokensPerCjkLetter: cjk > characters / 2 ? +((ct * oo - ot * co) / det).toFixed(3) : null,
      tokensPerOtherCharacter: cjk > characters / 2 ? +((ot * cc - ct * co) / det).toFixed(3) : +(tokens / characters).toFixed(3),
      upstreamGuessOverReal: +(third / tokens).toFixed(2), forkGuessOverReal: +(byLetter / tokens).toFixed(2),
    })
  }
}

console.log('| tokenizer | meetings | tokens a character | tokens a CJK letter | upstream\'s guess / real | fork\'s guess / real |')
console.log('|---|---|---|---|---|---|')
for (const r of results) console.log(`| ${r.tokenizer} | ${r.set} | ${r.tokensPerCharacter} | ${r.tokensPerCjkLetter ?? '-'} | ${r.upstreamGuessOverReal} | ${r.forkGuessOverReal} |`)
writeFileSync(join(here, 'results-tokens.json'), JSON.stringify({ node: process.version, platform: process.platform, date: new Date().toISOString().slice(0, 10), results }, null, 1) + '\n')
process.exit(0)
