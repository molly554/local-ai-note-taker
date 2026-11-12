import type { Helper } from './calendar'

/** Players Yogurt pauses while it records: they answer AppleScript */
export const MEDIA_APPS = ['com.apple.Music', 'com.spotify.client']

/**
 * Pause music when recording starts and play it again when it stops.
 * The helper pauses only players that are running and playing, and says which; only those are resumed.
 * The Mac asks once per player (Automation) the first time; a no, or any failure, is quiet.
 */
export function createMedia(d: { helper: Helper }) {
  let pausing: Promise<string[]> = Promise.resolve([])
  let holding = false
  return {
    /** paused something, or may have: quitting waits for resume() */
    holding: () => holding,
    async pause() {
      holding = true
      pausing = d.helper(['media-pause']).then((r) => {
        const list = (r as { paused?: unknown } | null)?.paused
        return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && MEDIA_APPS.includes(id)) : []
      }).catch(() => [])
      await pausing
    },
    /** capMs: a player that never answers must not hold up quitting */
    async resume(capMs = 30_000) {
      // taken before waiting, so a pause that starts meanwhile (the next recording) is its own
      const p = pausing
      // once: a second stop must not start the music the person paused themselves
      pausing = Promise.resolve([])
      holding = false
      let timer: NodeJS.Timeout | undefined
      const cap = new Promise<void>((r) => { timer = setTimeout(r, capMs) })
      await Promise.race([cap, (async () => {
        const ids = await p
        if (!ids.length) return
        try { await d.helper(['media-resume', ...ids]) } catch { /* quiet */ }
      })()])
      clearTimeout(timer)
    },
  }
}
