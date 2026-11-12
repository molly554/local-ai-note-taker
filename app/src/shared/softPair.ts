/** The 18×20 Soft pair field, sampled at 4× for crisp small curves. */
export function softPairAlpha(x: number, y: number, phase: number): number {
  const pull = (1 - Math.cos(phase * Math.PI * 2)) / 2
  const gap = 4.7 - 3.7 * pull
  let field = 0
  for (const side of [-1, 1]) {
    const dx = (x - 9 - side * gap) / (1 + pull * .12)
    const dy = (y - 10 - side * Math.sin(phase * Math.PI * 2) * .65) / (1 - pull * .08)
    field += 2.75 ** 2 / Math.max(.01, dx * dx + dy * dy)
  }
  return Math.max(0, Math.min(255, (field - .98) * 1700))
}
