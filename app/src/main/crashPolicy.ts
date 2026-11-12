/**
 * What to do when the audio helper dies mid-meeting: start it again once, as the next part of the same meeting's files
 * (picking up at the meeting time where the last audio ended; the parts are joined into one file per track when
 * the meeting stops), and if it dies again, stop the meeting with the notes and audio so far kept.
 * One policy per meeting.
 */
export type CrashDeps = {
  /** starts a new helper for the next part, in the same meeting folder; may throw */
  restart(): void
  /** tell the person recording hiccuped but goes on */
  hiccup(): void
  /** tell the person recording stopped, and stop the meeting */
  giveUp(): void
}

export function createCrashPolicy(d: CrashDeps) {
  let restarted = false
  return {
    ended(e: { crashed: boolean }): 'done' | 'restarted' | 'stopped' {
      if (!e.crashed) return 'done'
      if (!restarted) {
        restarted = true
        try { d.restart(); d.hiccup(); return 'restarted' } catch (err) { console.error('capture restart failed', err) }
      }
      d.giveUp()
      return 'stopped'
    },
  }
}
