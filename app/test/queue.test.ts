import { describe, expect, it, vi } from 'vitest'
import { createQueue, isSmallMac } from '../src/main/notes/queue'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('notes queue', () => {
  it('cancelling obsolete summary work waits for the running job and allows future jobs for the same note', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    let release!: () => void, aborted = false
    const running = q.enqueue(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      await new Promise<void>((resolve) => { release = resolve })
    }, 'enhance', 'resumed')
    const old = vi.fn(async () => {}), other = vi.fn(async () => {})
    const queued = q.enqueue(old, 'readahead', 'resumed')
    const kept = q.enqueue(other, 'enhance', 'other')
    let settled = false
    const cancelled = q.cancelAnalysis('resumed').then(() => { settled = true })
    await tick()
    expect(aborted).toBe(true)
    expect(settled).toBe(false)
    expect(old).not.toHaveBeenCalled()
    release(); await Promise.all([running, queued, kept, cancelled])
    expect(other).toHaveBeenCalledOnce()
    const fresh = vi.fn(async () => {})
    await q.enqueue(fresh, 'enhance', 'resumed')
    expect(fresh).toHaveBeenCalledOnce()
  })

  it('on a 16 GB Mac, an enhance job waits while recording, then runs when recording stops', async () => {
    let recording = true
    const q = createQueue({ recording: () => recording, smallMac: true })
    const ran = vi.fn(async () => {})
    const done = q.enqueue(ran, 'enhance')
    await tick(); await tick()
    expect(ran).not.toHaveBeenCalled()
    recording = false
    q.recordingChanged()
    await done
    expect(ran).toHaveBeenCalledOnce()
  })
  it('runs two meetings\' jobs one at a time, in order', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    const log: string[] = []
    let running = 0
    const job = (name: string) => async () => { running++; expect(running).toBe(1); log.push(`${name} start`); await tick(); log.push(`${name} end`); running-- }
    await Promise.all([q.enqueue(job('A'), 'enhance'), q.enqueue(job('B'), 'enhance')])
    expect(log).toEqual(['A start', 'A end', 'B start', 'B end'])
  })
  it('on a 16 GB Mac, chat waits during a recording too', async () => {
    let recording = true
    const q = createQueue({ recording: () => recording, smallMac: true })
    const ran = vi.fn(async () => {})
    const done = q.enqueue(ran, 'chat')
    await tick()
    expect(ran).not.toHaveBeenCalled()
    recording = false; q.recordingChanged()
    await done
    expect(ran).toHaveBeenCalledOnce()
  })
  it('on a bigger Mac, jobs run during a recording while transcription keeps up', async () => {
    const q = createQueue({ recording: () => true, smallMac: false, backlogMs: () => 5_000 })
    const log: string[] = []
    await q.enqueue(async () => { log.push('enhance') }, 'enhance')
    await q.enqueue(async () => { log.push('names') }, 'names')
    expect(log).toEqual(['enhance', 'names'])
  })
  it('on a bigger Mac, more than 30 s of audio waiting for transcription stops the running job; it runs again once that clears', async () => {
    vi.useFakeTimers()
    try {
      let backlog = 0
      const q = createQueue({ recording: () => true, smallMac: false, backlogMs: () => backlog })
      let tries = 0
      const done = q.enqueue(async (signal) => {
        tries++
        if (tries === 1) await new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
      }, 'enhance')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(tries).toBe(1)
      backlog = 31_000
      await vi.advanceTimersByTimeAsync(1_500)
      // stopped, and not started again while transcription is behind
      backlog = 20_000
      await vi.advanceTimersByTimeAsync(5_000)
      expect(tries).toBe(1)
      backlog = 2_000
      await vi.advanceTimersByTimeAsync(1_500)
      await done
      expect(tries).toBe(2)
    } finally { vi.useRealTimers() }
  })
  it('on a bigger Mac, a backlog of 30 s or less leaves the job alone', async () => {
    vi.useFakeTimers()
    try {
      const q = createQueue({ recording: () => true, smallMac: false, backlogMs: () => 30_000 })
      let aborted = false
      let finish!: () => void
      const done = q.enqueue((signal) => new Promise<void>((r) => { finish = r; signal.addEventListener('abort', () => { aborted = true }) }), 'enhance')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(aborted).toBe(false)
      finish(); await done
    } finally { vi.useRealTimers() }
  })
  it('on a 16 GB Mac, a recording that starts stops the running job and runs it again afterwards', async () => {
    let recording = false
    const q = createQueue({ recording: () => recording, smallMac: true })
    let tries = 0
    const done = q.enqueue(async (signal) => {
      tries++
      if (tries === 1) await new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
    }, 'enhance')
    await tick()
    recording = true; q.recordingChanged()
    await tick(); await tick()
    expect(tries).toBe(1)
    recording = false; q.recordingChanged()
    await done
    expect(tries).toBe(2)
  })
  it('the model is let go about 10 minutes after the queue empties, on every Mac; new work cancels that', async () => {
    vi.useFakeTimers()
    try {
      for (const smallMac of [true, false]) {
        const idle = vi.fn()
        const q = createQueue({ recording: () => false, smallMac, onIdle: idle })
        await q.enqueue(async () => {}, 'enhance')
        await vi.advanceTimersByTimeAsync(9 * 60_000)
        expect(idle).not.toHaveBeenCalled()
        await q.enqueue(async () => {}, 'names')
        await vi.advanceTimersByTimeAsync(9 * 60_000)
        expect(idle).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2 * 60_000)
        expect(idle).toHaveBeenCalledOnce()
      }
    } finally { vi.useRealTimers() }
  })
  it('a bigger Mac keeps the model while a meeting records (reading ahead), and lets it go 10 minutes after it stops', async () => {
    vi.useFakeTimers()
    try {
      let recording = true
      const idle = vi.fn()
      const q = createQueue({ recording: () => recording, smallMac: false, backlogMs: () => 0, onIdle: idle })
      await q.enqueue(async () => {}, 'readahead')
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(idle).not.toHaveBeenCalled()
      recording = false; q.recordingChanged()
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(idle).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(idle).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('isSmallMac: 24 GB and less wait for the meeting to end; 32 GB does not (os.totalmem as a Mac reports it)', () => {
    expect(isSmallMac(16 * 2 ** 30)).toBe(true)
    // a 24 GB Mac: 25,769,803,776 bytes, "25.8 GB" in the decimal units the hardware check shows
    expect(isSmallMac(25_769_803_776)).toBe(true)
    expect(isSmallMac(25.8e9)).toBe(true)
    expect(isSmallMac(34_359_738_368)).toBe(false)
    expect(isSmallMac(36 * 2 ** 30)).toBe(false)
  })
  it('cancel: a deleted meeting\'s jobs are dropped, the running one stopped and not run again, and later ones never run', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    let tries = 0
    const running = q.enqueue((signal) => { tries++; return new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))) }, 'enhance', 'gone')
    const waitingGone = vi.fn(async () => {})
    const waiting = q.enqueue(waitingGone, 'names', 'gone')
    const other = vi.fn(async () => {})
    const kept = q.enqueue(other, 'enhance', 'other')
    await tick()
    q.cancel('gone')
    await Promise.all([running, waiting, kept])
    const later = vi.fn(async () => {})
    await q.enqueue(later, 'chat', 'gone')
    expect(tries).toBe(1)
    expect(waitingGone).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledOnce()
    expect(q.busy()).toBe(false)
  })
  it('nothing runs before a notes model is on the Mac (first run); waiting jobs run once it arrives', async () => {
    let have = false
    const q = createQueue({ recording: () => false, smallMac: false, modelReady: () => have })
    const log: string[] = []
    const a = q.enqueue(async () => { log.push('names') }, 'names')
    const b = q.enqueue(async () => { log.push('enhance') }, 'enhance')
    await tick(); await tick()
    expect(log).toEqual([])
    have = true; q.modelArrived()
    await Promise.all([a, b])
    expect(log).toEqual(['names', 'enhance'])
  })
  it('a job that fails does not stop the next', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    await expect(q.enqueue(async () => { throw new Error('boom') }, 'enhance')).rejects.toThrow('boom')
    const ran = vi.fn(async () => {})
    await q.enqueue(ran, 'enhance')
    expect(ran).toHaveBeenCalled()
  })
  describe('reading ahead (low priority)', () => {
    it('waits behind every other job, even ones added after it', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      const log: string[] = []
      let release!: () => void
      const first = q.enqueue(() => new Promise<void>((r) => { release = () => { log.push('enhance'); r() } }), 'enhance')
      const ahead = q.enqueue(async () => { log.push('readahead') }, 'readahead')
      const names = q.enqueue(async () => { log.push('names') }, 'names')
      await tick(); release()
      await Promise.all([first, ahead, names])
      expect(log).toEqual(['enhance', 'names', 'readahead'])
    })
    it('a job added while it reads stops it, and it is dropped, not run again', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      let tries = 0
      const ahead = q.enqueue((signal) => { tries++; return new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))) }, 'readahead')
      await tick()
      const ran = vi.fn(async () => {})
      await q.enqueue(ran, 'enhance')
      await ahead
      await tick()
      expect(ran).toHaveBeenCalledOnce()
      expect(tries).toBe(1)
      expect(q.busy()).toBe(false)
    })
    it('only the newest waiting read ahead is kept', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      const log: string[] = []
      let release!: () => void
      const first = q.enqueue(() => new Promise<void>((r) => { release = r }), 'enhance')
      const a = q.enqueue(async () => { log.push('old') }, 'readahead')
      const b = q.enqueue(async () => { log.push('new') }, 'readahead')
      release()
      await Promise.all([first, a, b])
      expect(log).toEqual(['new'])
    })
    it('on a 16 GB Mac only while nothing records: one waiting goes when a recording starts', async () => {
      let recording = true
      const q = createQueue({ recording: () => recording, smallMac: true })
      const ran = vi.fn(async () => {})
      await q.enqueue(ran, 'readahead')
      expect(ran).not.toHaveBeenCalled()
      recording = false
      await q.enqueue(ran, 'readahead')
      expect(ran).toHaveBeenCalledOnce()
      // waiting behind a long job when a recording starts: dropped, not run once it ends
      let release!: () => void
      const long = q.enqueue((signal) => new Promise<void>((r) => { release = r; signal.addEventListener('abort', () => r()) }), 'enhance')
      const late = q.enqueue(ran, 'readahead')
      recording = true; q.recordingChanged()
      await late
      recording = false; q.recordingChanged(); release()
      await long
      await tick()
      expect(ran).toHaveBeenCalledOnce()
    })
    it('does not start while more than 10 s of audio waits for transcription, and stops when it gets there', async () => {
      vi.useFakeTimers()
      try {
        let backlog = 12_000
        const q = createQueue({ recording: () => true, smallMac: false, backlogMs: () => backlog })
        let tries = 0, aborted = false
        const done = q.enqueue((signal) => { tries++; return new Promise<void>((r) => signal.addEventListener('abort', () => { aborted = true; r() })) }, 'readahead')
        await vi.advanceTimersByTimeAsync(3_000)
        expect(tries).toBe(0)
        backlog = 4_000
        await vi.advanceTimersByTimeAsync(1_500)
        expect(tries).toBe(1)
        backlog = 11_000
        await vi.advanceTimersByTimeAsync(1_500)
        expect(aborted).toBe(true)
        await done
        backlog = 0
        await vi.advanceTimersByTimeAsync(5_000)
        expect(tries).toBe(1)
      } finally { vi.useRealTimers() }
    })
  })
  it('a question goes ahead of other notes work still waiting (someone is waiting on it)', async () => {
    const q = createQueue({ recording: () => false, smallMac: false })
    const log: string[] = []
    const job = (name: string) => async () => { log.push(name); await tick() }
    await Promise.all([q.enqueue(job('notes A'), 'enhance'), q.enqueue(job('notes B'), 'enhance'), q.enqueue(job('names C'), 'names'), q.enqueue(job('chat'), 'chat')])
    expect(log).toEqual(['notes A', 'chat', 'notes B', 'names C'])
  })
  describe('indexing meetings for chat across them (lowest priority)', () => {
    it('comes after everything else, reading ahead too', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      const log: string[] = []
      let release!: () => void
      const first = q.enqueue(() => new Promise<void>((r) => { release = () => { log.push('enhance'); r() } }), 'enhance')
      const index = q.enqueue(async () => { log.push('index') }, 'index')
      const ahead = q.enqueue(async () => { log.push('readahead') }, 'readahead')
      const names = q.enqueue(async () => { log.push('names') }, 'names')
      await tick(); release()
      await Promise.all([first, index, ahead, names])
      expect(log).toEqual(['enhance', 'names', 'readahead', 'index'])
    })
    it('a job added while it runs stops it, and it runs again after (what it did stays done)', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      let tries = 0
      const index = q.enqueue((signal) => { tries++; return tries > 1 ? Promise.resolve() : new Promise<void>((r) => signal.addEventListener('abort', () => r())) }, 'index')
      await tick()
      const ran = vi.fn(async () => {})
      await q.enqueue(ran, 'chat')
      await index
      expect(ran).toHaveBeenCalledOnce()
      expect(tries).toBe(2)
    })
    it('never while a meeting records, on any Mac: it waits for the end', async () => {
      let recording = true
      const q = createQueue({ recording: () => recording, smallMac: false })
      const ran = vi.fn(async () => {})
      const done = q.enqueue(ran, 'index')
      await tick(); await tick()
      expect(ran).not.toHaveBeenCalled()
      recording = false
      q.recordingChanged()
      await done
      expect(ran).toHaveBeenCalledOnce()
    })
    it('one waiting pass is enough: another asked for meanwhile is the same one', async () => {
      const q = createQueue({ recording: () => false, smallMac: false })
      let release!: () => void
      const first = q.enqueue(() => new Promise<void>((r) => { release = r }), 'enhance')
      const ran = vi.fn(async () => {})
      const a = q.enqueue(ran, 'index'), b = q.enqueue(ran, 'index')
      release()
      await Promise.all([first, a, b])
      expect(ran).toHaveBeenCalledOnce()
    })
  })
})
