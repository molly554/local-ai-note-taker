/**
 * Streamed text, revealed smoothly: chunks from the model arrive in bursts, and showing each burst at once makes the
 * text jump. Each frame shows a few more characters, at most 5 ms apart, and faster the bigger the backlog (the
 * backlog drains in about 250 ms), so a fast model is never held back. Once streaming ends or is stopped, or with
 * reduced motion, the full text shows at once. Pure: the caller gives the time (see `useSmoothText`).
 */
export const DRAIN_MS = 250
export const MAX_CHAR_MS = 5

const common = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
/** a cut between the two halves of one character (an emoji) moves past it */
const whole = (text: string, at: number) => {
  const c = text.charCodeAt(at - 1)
  return c >= 0xd800 && c <= 0xdbff && at < text.length ? at + 1 : at
}

/** the part of `shown` that `text` still starts with (all of it while text only grows) */
export const stillShown = (shown: string, text: string) => (text.startsWith(shown) ? shown : text.slice(0, whole(text, common(shown, text))))

export class TextSmoother {
  shown: string
  private target: string
  /** when the time not yet spent on characters began */
  private since = 0

  /** text that is streaming starts empty and unrolls; text that is not shows in full */
  constructor(text: string, live: boolean) {
    this.target = text
    this.shown = live ? '' : text
  }

  get settled() { return this.shown === this.target }

  /** new text, or the stream ended (`live` false) */
  update(text: string, live: boolean, now: number, reduced = false) {
    const wasSettled = this.settled
    this.target = text
    if (!live || reduced) { this.shown = text; return }
    // a reading that changed (a corrected partial): keep what still matches
    this.shown = stillShown(this.shown, text)
    // time spent waiting for this chunk is not saved up into a jump
    if (wasSettled) this.since = now
  }

  /** an animation frame: reveal what the time since the last character allows */
  tick(now: number) {
    const left = this.target.length - this.shown.length
    if (left <= 0) { this.since = now; return }
    const perChar = Math.min(MAX_CHAR_MS, DRAIN_MS / left)
    const add = Math.min(left, Math.floor((now - this.since) / perChar))
    if (add <= 0) return
    this.shown = this.target.slice(0, whole(this.target, this.shown.length + add))
    this.since = this.settled ? now : this.since + add * perChar
  }
}
