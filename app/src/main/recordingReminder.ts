import type { RecordingStart } from './meeting'

/** A single pending reminder survives renderer navigation, but never a Resume or a stopped call. */
export function createRecordingReminder(enabled: () => boolean) {
  let pending: string | null = null
  return {
    started(m: Pick<RecordingStart, 'id' | 'resume'>) { pending = !m.resume && enabled() ? m.id : null },
    stopped() { pending = null },
    take() {
      const id = pending
      pending = null
      return id && enabled() ? id : null
    },
  }
}
