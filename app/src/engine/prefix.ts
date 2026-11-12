/**
 * Does the sequence start with this text (after the chat format's few opening tokens)? The text's first token and
 * last two are left out: next to the format's tokens, or to what followed, they may have been split differently.
 */
export function holds(context: readonly unknown[], text: readonly unknown[], lead = 24): boolean {
  const body = text.slice(1, -2)
  if (body.length < 8) return false
  for (let k = 1; k <= lead && k + body.length <= context.length; k++) {
    let i = 0
    while (i < body.length && context[k + i] === body[i]) i++
    if (i === body.length) return true
  }
  return false
}
