const blocks = [
  '## Tuesday launch',
  '- Publish the page Tuesday.',
  '- Announce it Wednesday morning.',
  '## Next steps',
  '- **Kara:** Release notes by Friday.',
  '- **You:** Send Ray the asset list by Friday.',
]
export const finalPlan = blocks.join('\n')
// Keep the opening beat; shorten writing and block pauses by 20 percent.
const starts = [.95, 1.55, 2.6, 3.6, 4, 5.3].map(time => .95 + (time - .95) * .8)
export function fragmentSummaryAt(time) {
  return blocks.flatMap((block, index) => {
    const [, prefix, text] = block.match(/^(## |- )(.*)$/)
    const words = text.split(' '), pace = (index < 3 ? .16 : .14) * .8
    const count = Math.max(0, Math.min(words.length, Math.floor((time - starts[index]) / pace) + 1))
    return count ? [prefix + words.slice(0, count).join(' ')] : []
  }).join('\n')
}
export const summarySettled = 5.75
