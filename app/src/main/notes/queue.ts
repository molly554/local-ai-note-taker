/**
 * readahead: reading a meeting into the model ahead of what will ask about it (while it is recorded, readAhead.ts; when
 * its Ask opens, chat.ts warm); it comes late, never while a small Mac records, and is never run again.
 * index: chunking and embedding meetings for chat across them (library/indexer.ts); it comes last, never while a
 * meeting records, and gives way to anything else (run again after: what it did stays done).
 * folder: one folder proposal per meeting, with the same priority and recording policy as indexing.
 */
export type JobKind = 'names' | 'enhance' | 'chat' | 'readahead' | 'index' | 'folder'
/** A job gets a signal: aborted when a recording starts on a small Mac. It is then run again from the start later. */
export type Job = (signal: AbortSignal) => Promise<void>

type Entry = { job: Job; kind: JobKind; meetingId?: string; cancelled?: boolean; done: Promise<void>; resolve(): void; reject(e: unknown): void }

/** How long the notes model stays loaded once there is nothing left to do and nothing records (every Mac) */
export const IDLE_UNLOAD_MS = 10 * 60_000
/**
 * 24 GB or less: the notes model and a recording don't fit in memory together. A 24 GB Mac reports 24 GiB
 * (25.8 decimal GB), so the line sits halfway to 32 GB rather than on an exact number.
 */
export const isSmallMac = (totalBytes: number): boolean => totalBytes < 28 * 2 ** 30

/** On a bigger Mac, audio waiting for transcription past this stops model work; it starts again under RESUME_MS */
export const BACKLOG_MS = 30_000
export const RESUME_MS = 10_000
/** reading ahead only starts, and goes on, while transcription has this little audio waiting */
export const READ_BACKLOG_MS = 10_000
/** how often a bigger Mac looks at the transcription backlog while there is model work */
const CHECK_MS = 1000

/**
 * Every model job, one at a time, in order (a question first: someone is waiting on it). Recording always wins:
 * - on a small Mac nothing runs while a meeting records: a running job is stopped (run again afterwards) and the
 *   model is let go;
 * - on a bigger Mac jobs run during a recording, but when transcription falls more than 30 s behind on a track the
 *   running job is stopped and run again once it has caught up (under 10 s).
 */
export function createQueue(o: {
  recording: () => boolean
  smallMac: boolean
  /** the most audio waiting for transcription on any track, in ms (bigger Macs) */
  backlogMs?: () => number
  /** nothing to do for IDLE_UNLOAD_MS with nothing recording, or a recording started on a small Mac: the model can go */
  onIdle?: () => void
  idleMs?: number
  /** a notes model is on the Mac (first run: not until its download lands); nothing runs before */
  modelReady?: () => boolean
}) {
  const waiting: Entry[] = []
  let running: { entry: Entry; abort: AbortController } | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let watch: NodeJS.Timeout | undefined
  /** a bigger Mac stopped for the backlog: waiting for it to fall under RESUME_MS */
  let yielded = false
  /** the log has said the jobs wait for the first notes model */
  let saidWait = false
  /** deleted meetings: their jobs are dropped, now and later */
  const gone = new Set<string>()

  const backlog = () => o.backlogMs?.() ?? 0
  const allowed = (kind: JobKind) => {
    if (o.modelReady && !o.modelReady()) return false
    if ((kind === 'index' || kind === 'folder') && o.recording()) return false
    if (kind === 'readahead' && !o.smallMac && backlog() > READ_BACKLOG_MS) return false
    if (o.smallMac) return !o.recording()
    if (yielded && backlog() < RESUME_MS) yielded = false
    return !yielded && backlog() <= BACKLOG_MS
  }

  // bigger Macs: look at the backlog while there is model work
  const watching = () => {
    const want = !o.smallMac && !!o.backlogMs && (!!running || waiting.length > 0)
    if (want && !watch) watch = setInterval(() => {
      if (running?.entry.kind === 'readahead' && backlog() > READ_BACKLOG_MS) running.abort.abort()
      else if (running && backlog() > BACKLOG_MS) { yielded = true; running.abort.abort() }
      pump()
    }, CHECK_MS)
    if (!want && watch) { clearInterval(watch); watch = undefined }
  }

  // while a meeting records the model stays (a bigger Mac reads ahead with it); stopping arms this again
  const armIdle = () => {
    if (!o.onIdle || idleTimer || o.recording()) return
    idleTimer = setTimeout(() => { idleTimer = undefined; if (!running && !waiting.length && !o.recording()) o.onIdle?.() }, o.idleMs ?? IDLE_UNLOAD_MS)
  }
  const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined } }

  /** a stopped job starts over later; a stopped read ahead is dropped (the next one reads what is new by then) */
  const again = (e: Entry) => { if (e.cancelled || e.kind === 'readahead' || (e.meetingId && gone.has(e.meetingId))) e.resolve(); else waiting.unshift(e) }

  const pump = () => {
    watching()
    if (running) return
    // a question first (someone is waiting on it), reading ahead only once nothing else can run
    let i = waiting.findIndex((e) => e.kind === 'chat' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => e.kind !== 'readahead' && e.kind !== 'index' && e.kind !== 'folder' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => e.kind === 'readahead' && allowed(e.kind))
    if (i === -1) i = waiting.findIndex((e) => (e.kind === 'index' || e.kind === 'folder') && allowed(e.kind))
    if (i === -1) {
      if (!waiting.length) armIdle()
      else if (o.modelReady && !o.modelReady() && !saidWait) { saidWait = true; console.info('NOTES', 'waiting for the notes model to finish downloading') }
      watching(); return
    }
    disarmIdle()
    const [entry] = waiting.splice(i, 1)
    const abort = new AbortController()
    running = { entry, abort }
    void (async () => {
      try {
        await entry.job(abort.signal)
        if (abort.signal.aborted) again(entry)
        else entry.resolve()
      } catch (e) {
        // stopped for a recording or the backlog: it goes back to the front and starts over later
        if (abort.signal.aborted) again(entry)
        else entry.reject(e)
      } finally {
        running = undefined
        pump()
        watching()
      }
    })()
  }

  return {
    /** meetingId: whose job it is, so deleting the meeting can drop it */
    enqueue(job: Job, kind: JobKind, meetingId?: string): Promise<void> {
      let resolve!: () => void, reject!: (e: unknown) => void
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      // Not while a small Mac records; deleted meetings never receive new work.
      if ((kind === 'readahead' && o.smallMac && o.recording()) || (meetingId && gone.has(meetingId))) { resolve(); return done }
      if (kind === 'readahead') {
        for (const e of waiting.filter((x) => x.kind === 'readahead')) { waiting.splice(waiting.indexOf(e), 1); e.resolve() }
      } else if (kind === 'index') {
        // a pass goes over every meeting: one waiting is enough
        const queued = waiting.find((x) => x.kind === 'index')
        if (queued) { resolve(); return queued.done }
      } else if (kind !== 'folder' && (running?.entry.kind === 'readahead' || running?.entry.kind === 'index' || running?.entry.kind === 'folder')) running.abort.abort()
      waiting.push({ job, kind, meetingId, done, resolve, reject })
      pump()
      return done
    },
    /** Resume replaces only old analysis, without the permanent tombstone used for deletion. */
    cancelAnalysis(meetingId: string): Promise<void> {
      const matches = (e: Entry) => e.meetingId === meetingId && (e.kind === 'enhance' || e.kind === 'readahead' || e.kind === 'folder')
      for (const e of waiting.filter(matches)) { waiting.splice(waiting.indexOf(e), 1); e.cancelled = true; e.resolve() }
      if (!running || !matches(running.entry)) return Promise.resolve()
      const { entry, abort } = running
      entry.cancelled = true; abort.abort()
      return entry.done.catch(() => {})
    },
    /** call when any recording starts or stops */
    recordingChanged() {
      if (o.recording()) disarmIdle()
      if (o.recording() && (running?.entry.kind === 'index' || running?.entry.kind === 'folder')) running.abort.abort()
      if (o.recording() && o.smallMac) {
        // a read ahead waiting would be stale by the time the meeting ends
        for (const e of waiting.filter((x) => x.kind === 'readahead')) { waiting.splice(waiting.indexOf(e), 1); e.resolve() }
        running?.abort.abort()
        o.onIdle?.()
      }
      pump()
    },
    /** the meeting was deleted: its waiting jobs are dropped, its running one stopped, and any added later never run */
    cancel(meetingId: string) {
      gone.add(meetingId)
      for (const e of waiting.filter((x) => x.meetingId === meetingId)) { waiting.splice(waiting.indexOf(e), 1); e.resolve() }
      if (running?.entry.meetingId === meetingId) running.abort.abort()
      pump()
    },
    /** the first notes model has landed: what waited for it runs now */
    modelArrived() { pump() },
    busy: () => !!running || waiting.length > 0,
  }
}
export type Queue = ReturnType<typeof createQueue>
