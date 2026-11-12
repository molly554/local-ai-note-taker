import { citationTargetIndex } from '../../../shared/citations'
import { SPEAKER_COLORS } from '../../../shared/speakerColors'
import { ScrollFade } from './ScrollFade'
import { Loading } from './Loading'
import { useLoadingState } from '../useLoadingState'
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { AudioLines, ArrowDown, ChevronDown, Search as SearchIcon } from 'lucide-react'
import type { Segment, TranscriptPartial } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { useLanguage } from '../i18n'
import { bubbles, clock, echoRuns, echoedLinesLabel, filterLines, lineAt, stableKeys, turns, withLive, type LiveSaid } from '../../../shared/transcript'
import { markWords } from '../../../shared/highlight'
import { Player, type PlayerHandle } from './Player'
import { rememberedScroll, useScrollMemory } from '../useScrollMemory'
import { followGlide, scrollBehavior } from '../motion'
import { followTarget, inView } from '../../../shared/follow'
import { afterFinal, joinWords } from '../../../shared/liveWords'

type Line = Omit<Segment, 'id'> & { id?: number }
const key = (l: { track: string; startMs: number }) => `${l.track}:${l.startMs}`
/** this close to the bottom still counts as reading the latest lines */
const STICK_PX = 24
const rememberedEchoes = new Map<string, Set<string>>()
/** after their own scroll, playing waits this long before it moves the list, so it never takes over mid-gesture */
const HANDS_OFF_MS = 400

/** You on the mic; on the other side the name the call app showed talking, Them when it showed none */
const who = (l: { track: string; speaker?: string | null }): string => (l.track === 'me' ? t('You') : l.speaker || t('Them'))

/** The lines of a meeting, live while it records; `live` holds the lines that arrived while watching */
function useLines(id: string) {
  const [lines, setLines] = useState<Line[]>([])
  const [loaded, setLoaded] = useState(false)
  const live = useRef(new Set<string>())
  useEffect(() => {
    let active = true
    setLoaded(false); setLines([]); live.current = new Set()
    const add = (more: Line[], arriving: boolean) => setLines((cur) => {
      const seen = new Set(cur.map(key))
      const fresh = more.filter((l) => l.meetingId === id && !seen.has(key(l)))
      if (arriving) for (const l of fresh) live.current.add(key(l))
      return fresh.length ? [...cur, ...fresh].sort((a, b) => a.startMs - b.startMs) : cur
    })
    const off = window.yogurt.transcript.onSegment((l) => add([l], true))
    void window.yogurt.transcript.get(id, { hidden: true }).then((saved) => { if (active) { add(saved, false); setLoaded(true) } })
    // names settled after the meeting, or lines hidden or shown again: the saved lines replace the ones shown
    const offSpeakers = window.yogurt.transcript.onSpeakers((m) => {
      if (m !== id) return
      void window.yogurt.transcript.get(id, { hidden: true }).then((saved) => setLines((cur) => {
        const fresh = new Map(saved.map((l) => [key(l), l]))
        const have = new Set(cur.map(key))
        return [...cur.map((l) => fresh.get(key(l)) ?? l), ...saved.filter((l) => !have.has(key(l)))].sort((a, b) => a.startMs - b.startMs)
      }))
    })
    return () => { active = false; off(); offSpeakers() }
  }, [id])
  return { lines, live, loaded }
}

/**
 * What each side is saying right now, not final yet: one reading per track, replaced as it grows. A final line that
 * arrives takes its own words off at once (shared/liveWords), in the same render that shows it, so nothing shows twice.
 * `previewed` tells a final line that took the place of live words (it settles in place instead of fading in).
 */
function useLive(id: string, recording: boolean) {
  const [parts, setParts] = useState<Partial<Record<'me' | 'them', LiveSaid>>>({})
  /** how far each side's live words have reached */
  const seen = useRef<Record<'me' | 'them', number>>({ me: -Infinity, them: -Infinity })
  useEffect(() => {
    setParts({}); seen.current = { me: -Infinity, them: -Infinity }
    if (!recording) return
    const offPartial = window.yogurt.transcript.onPartial((p) => {
      if (p.meetingId !== id) return
      const words = p.words ?? []
      if (words.length) seen.current[p.track] = Math.max(seen.current[p.track], words.at(-1)!.endMs)
      setParts((cur) => ({ ...cur, [p.track]: { track: p.track, startMs: words[0]?.startMs ?? p.startMs, endMs: words.at(-1)?.endMs ?? p.startMs, text: p.text, words } }))
    })
    const offSegment = window.yogurt.transcript.onSegment((l) => {
      if (l.meetingId !== id) return
      setParts((cur) => {
        const had = cur[l.track]
        if (!had) return cur
        const words = afterFinal(had.words, { endMs: l.endMs, text: l.text })
        return { ...cur, [l.track]: { ...had, words, text: joinWords(words), startMs: words[0]?.startMs ?? had.startMs } }
      })
    })
    return () => { offPartial(); offSegment() }
  }, [id, recording])
  const previewed = useCallback((l: { track: 'me' | 'them'; startMs: number }) => l.startMs < seen.current[l.track] + 500, [])
  return { live: (['me', 'them'] as const).map((t) => parts[t]).filter((x): x is LiveSaid => !!x && x.words.length > 0), previewed }
}

/**
 * Live words as they come: lighter than final text, each new word fading in where it lands; a word read again
 * differently changes in place. Three soft dots after them say more is coming.
 */
export function LiveWords({ said }: { said: LiveSaid }) {
  const keys = useRef<{ words: string[]; keys: number[]; next: number }>({ words: [], keys: [], next: 0 })
  const texts = said.words.map((w) => w.text)
  const k = stableKeys(keys.current.words, keys.current.keys, texts, keys.current.next)
  keys.current = { words: texts, keys: k.keys, next: k.next }
  return (
    <span data-testid="transcript-partial" data-track={said.track} data-start={said.startMs} aria-live="off" className="live-words">
      {said.words.map((w, i) => <span key={k.keys[i]} className="live-word">{i === 0 || w.glue ? w.text : ` ${w.text}`}</span>)}
      <span className="live-dots" aria-hidden="true"><i /><i /><i /></span>
    </span>
  )
}

type RowProps = {
  line: Line
  /** the line an answer across meetings pointed to */
  focused?: boolean
  name: string; query: string
  playing: boolean; playable: boolean; focusable: boolean
  /** arrived while watching: fades in, or settles in place where live words stood for it */
  arrived: 'fade' | 'settle' | null
  onPlay: (l: Line, e: MouseEvent) => void; onFocusLine: (k: string) => void
  /** an echo line hidden after the meeting, shown on request: dimmed, with a way back */
  onRestore?: (l: Line) => void
}
/**
 * One line of the transcript, a stretch of text in its bubble (who said it heads the turn). Drawn again only when what
 * it shows changes (a long meeting has thousands).
 */
const Row = memo(function Row({ line: l, focused, name, query, playing, playable, focusable, arrived, onPlay, onFocusLine, onRestore }: RowProps) {
  // memo skips it otherwise when the language changes
  useLanguage()
  if (window.yogurt.fake) (window as unknown as { __rowRenders?: number }).__rowRenders = ((window as unknown as { __rowRenders?: number }).__rowRenders ?? 0) + 1
  const k = key(l), time = clock(l.startMs)
  return (
    <span data-key={k} data-testid="transcript-line" data-track={l.track} data-start={l.startMs} data-playing={playing || undefined}
      role={playable ? 'button' : undefined} aria-label={playable ? t('Play from {time}, {name}: {text}', { time, name, text: l.text }) : undefined}
      tabIndex={playable ? (focusable ? 0 : -1) : undefined} onFocus={(e) => { if (e.target === e.currentTarget) onFocusLine(k) }}
      onClick={(e) => onPlay(l, e)} title={time}
      data-hidden={l.hidden || undefined} data-focused={focused || undefined}
      className={`line ${arrived === 'fade' ? 'line-in' : arrived === 'settle' ? 'line-settle' : ''} ${playable ? 'line-playable cursor-pointer' : ''}`}>
      <span data-testid="transcript-text">
        {query ? markWords(l.text, query).map((p, i) => (p.hit ? <mark key={i} className="search-mark">{p.text}</mark> : <span key={i}>{p.text}</span>)) : l.text}
      </span>
      <time data-testid="transcript-time" className="sr-only">{time}</time>
      {l.hidden && onRestore && <button data-testid="transcript-restore" onClick={(e) => { e.stopPropagation(); onRestore(l) }} className="transcript-restore">{t('Restore')}</button>}
    </span>
  )
})

/**
 * The meeting's transcript: each turn carries who said it, following new lines
 * while it records; after the meeting a line plays from that moment, and the player sits at the bottom. The header searches it.
 */
export function Transcript({ id, recording, inline = false, active = true, onClose, focus, toolbar }: {
  id: string; recording: boolean; inline?: boolean; active?: boolean; toolbar?: HTMLElement | null; onClose?: () => void
  /** a line to show and mark (an answer's source): ms into the meeting; seq: each time it is asked for */
  focus?: { ms: number; match?: string; seq: number }
}) {
  const { lines: allLines, live, loaded } = useLines(id)
  const loadingPhase = useLoadingState(!loaded)
  const { live: liveSaid, previewed } = useLive(id, recording)
  const [echoState, setEchoState] = useState(() => ({ id, keys: rememberedEchoes.get(id) ?? new Set<string>() }))
  const expanded = useMemo(() => echoState.id === id ? echoState.keys : rememberedEchoes.get(id) ?? new Set<string>(), [id, echoState])
  const timeline = useMemo(() => echoRuns(withLive(allLines, liveSaid)), [allLines, liveSaid])
  const isExpanded = (run: typeof timeline[number]) => run.lines.some(l => expanded.has(key(l)))
  const toggleEcho = (run: typeof timeline[number]) => {
    const keys = new Set(expanded), open = isExpanded(run)
    for (const line of run.lines) { if (open) keys.delete(key(line)); else keys.add(key(line)) }
    rememberedEchoes.set(id, keys); setEchoState({ id, keys })
  }
  useEffect(() => {
    const keys = new Set(expanded)
    for (const run of timeline) if (run.echo && isExpanded(run)) for (const line of run.lines) keys.add(key(line))
    if (keys.size !== expanded.size) { rememberedEchoes.set(id, keys); setEchoState({ id, keys }) }
  }, [timeline, expanded, id])
  const lines = useMemo(() => timeline.flatMap(run => run.echo && !isExpanded(run) ? [] : run.lines.filter((l): l is Line => !('live' in l))), [timeline, expanded])
  const [restoreError, setRestoreError] = useState(false)
  const restoreFocus = useRef<string | undefined>(undefined)
  // Never fall through to restore-all for a live line whose stored ID has not arrived yet.
  const restore = useCallback((l: Line) => {
    if (l.id === undefined) return
    setRestoreError(false)
    if (document.activeElement?.closest('[data-key]')?.getAttribute('data-key') === key(l)) restoreFocus.current = key(l)
    void window.yogurt.transcript.restore(id, [l.id]).catch(() => { restoreFocus.current = undefined; setRestoreError(true) })
  }, [id])
  const [query, setQuery] = useState('')
  const pointerSearch = useRef(false)
  const [animateSearch, setAnimateSearch] = useState(false)
  useEffect(() => { setQuery(''); setRestoreError(false) }, [id])

  // the recording is only playable once it is finished
  const [tracks, setTracks] = useState<Array<'me' | 'them'>>([])
  useEffect(() => {
    setTracks([])
    if (recording) return
    let on = true
    void window.yogurt.audio.tracks(id).then((t) => { if (on) setTracks(t) })
    return () => { on = false }
  }, [id, recording])
  const player = useRef<PlayerHandle>(null)
  const playable = tracks.length > 0
  const playbackDock = useRef<HTMLDivElement>(null)
  const [playbackInset, setPlaybackInset] = useState(0)
  useLayoutEffect(() => {
    const dock = playbackDock.current
    if (!inline || !dock) { setPlaybackInset(0); return }
    // Reserve the actual controls height, including playback errors and larger text.
    const measure = () => setPlaybackInset(dock.getBoundingClientRect().height + 16)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [inline, playable, active])

  // the line being played: found by a binary search on each tick, drawn only when it changes
  const [shownKey, setShownKey] = useState<string>()
  const [seek, setSeek] = useState(0)
  const followedSeek = useRef(0)
  const linesRef = useRef(lines)
  linesRef.current = lines
  const onTime = useCallback((ms: number | null, seeking = false) => {
    const i = ms == null ? -1 : lineAt(linesRef.current, ms)
    const k = i < 0 ? undefined : key(linesRef.current[i])
    setShownKey((cur) => (cur === k ? cur : k))
    if (seeking) setSeek((n) => n + 1)
  }, [])

  // follow the newest line while recording, unless they scrolled up to read
  const scrollKey = `transcript/${id}`
  const list = useScrollMemory<HTMLOListElement>(scrollKey, active && loaded)
  const stick = useRef(rememberedScroll(scrollKey) === undefined)
  const [behind, setBehind] = useState(false)
  const onScroll = () => {
    const el = list.current
    if (!el) return
    // not Yogurt's own glide, so theirs (the scroll bar dragged, a trackpad's glide): playing keeps its hands off while it lasts
    if (ours.current === null) { handsOn.current = performance.now(); theyScrolled() }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    setBehind(!stick.current)
  }
  useLayoutEffect(() => {
    const el = list.current
    if (active && recording && el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines, liveSaid, recording, active])
  const toLatest = () => { const el = list.current; if (el) { stick.current = true; setBehind(false); el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() }) } }

  // playing follows along: the line being played kept comfortably in view, until they scroll it out of sight
  const rowOf = (k?: string) => (k ? list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`) ?? null : null)
  useLayoutEffect(() => {
    const k = restoreFocus.current
    if (!k || !allLines.some(l => key(l) === k && !l.hidden)) return
    const row = rowOf(k)
    if (row) { if (!row.hasAttribute('tabindex')) row.tabIndex = -1; row.focus({ preventScroll: true }) }
    restoreFocus.current = undefined
  }, [allLines])
  const [audioOn, setAudioOn] = useState(false)
  const following = useRef(true)
  /** where the line being played went while they looked elsewhere, for Back to playing */
  const [away, setAway] = useState<'up' | 'down' | null>(null)
  /** stops Yogurt's own glide while it moves; its scroll events are not taken for theirs */
  const ours = useRef<ReturnType<typeof followGlide> | null>(null)
  /** when they last turned the wheel, pressed a key or touched the list: a glide started then would swallow their scroll */
  const handsOn = useRef(0)
  const shownKeyRef = useRef(shownKey)
  shownKeyRef.current = shownKey
  useEffect(() => { following.current = true; setAway(null) }, [id])
  /** the row's place in the list's content and the list's scroll */
  const measure = (row: HTMLElement) => {
    const el = list.current!, box = el.getBoundingClientRect(), r = row.getBoundingClientRect()
    const top = r.top - box.top + el.scrollTop
    return { row: { top, bottom: top + r.height }, view: { scrollTop: el.scrollTop, height: Math.max(0, el.clientHeight - playbackInset), scrollHeight: el.scrollHeight } }
  }
  const showPlaying = (always: boolean) => {
    const el = list.current, row = rowOf(shownKeyRef.current)
    if (!el || !row || (!always && performance.now() - handsOn.current < HANDS_OFF_MS)) return
    const { row: r, view } = measure(row)
    const to = followTarget(r, view, always)
    if (to === null || !ours.current && Math.abs(to - el.scrollTop) < 2) return
    if (!ours.current) {
      // The final scroll event arrives after done. A fresh seek in that frame still belongs to Yogurt.
      const motion = followGlide(el, () => requestAnimationFrame(() => {
        if (ours.current === motion && !motion.active) ours.current = null
      }))
      ours.current = motion
    }
    ours.current.to(to)
  }
  // An explicit seek asks to follow again, even paused or within the same line. Ordinary ticks respect reading elsewhere.
  useEffect(() => {
    if (seek !== followedSeek.current) {
      followedSeek.current = seek
      following.current = true; setAway(null)
      showPlaying(true)
    } else if (audioOn && following.current) showPlaying(false)
  }, [shownKey, audioOn, seek])
  const follow = useCallback(() => { following.current = true; setAway(null) }, [])
  const backToPlaying = () => { follow(); showPlaying(true) }
  /** a scroll of theirs: following goes on while the line being played still shows, and stops once it is out of sight */
  const theyScrolled = () => {
    const el = list.current, row = rowOf(shownKeyRef.current)
    if (recording || !el || !row) return
    const { row: r, view } = measure(row)
    following.current = inView(r, view)
    setAway(following.current ? null : r.top < view.scrollTop ? 'up' : 'down')
  }
  // a wheel, a key, a touch or a press (the scroll bar too): a glide of Yogurt's still moving is stopped, so it can't carry them back
  const theirs = () => {
    handsOn.current = performance.now()
    ours.current?.stop()
    ours.current = null
  }
  useEffect(() => () => { ours.current?.stop(); ours.current = null }, [id, active])

  const playableRef = useRef(playable)
  playableRef.current = playable
  const onPlay = useCallback((l: Line, e: MouseEvent) => {
    // a button, or text being selected to copy, is not a request to play
    if (!playableRef.current || (e.target as HTMLElement).closest('button, input, form') || window.getSelection()?.toString()) return
    follow()
    player.current?.playFrom(l.startMs)
  }, [follow])

  const shownLines = useMemo(() => filterLines(lines, query), [lines, query])

  // the line an answer pointed to: in the middle of the panel, marked, and the list's tab stop
  const [focusedKey, setFocusedKey] = useState<string>()
  const focusDone = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!active || !focus || focusDone.current === focus.seq || !lines.length) return
    const visible = lines.filter(line => !line.hidden)
    const match = focus.match ? visible[citationTargetIndex(visible.map(line => line.text), focus.match, Math.max(0, lineAt(visible, focus.ms)))] : undefined
    const l = match ?? lines[Math.max(0, lineAt(lines, focus.ms))]
    if (!l) return
    focusDone.current = focus.seq
    stick.current = false
    setFocusedKey(key(l)); setFocusKey(key(l))
    requestAnimationFrame(() => rowOf(key(l))?.scrollIntoView({ block: 'center' }))
  }, [focus?.seq, lines, active])
  useEffect(() => {
    if (!focusedKey) return
    const timer = window.setTimeout(() => setFocusedKey(undefined), 2400)
    return () => clearTimeout(timer)
  }, [focusedKey, focus?.seq])
  // one tab stop for the whole list (the line last focused, or playing, or the first); arrows move between lines
  const [focusKey, setFocusKey] = useState<string>()
  const tabKey = focusKey ?? shownKey ?? (shownLines[0] && key(shownLines[0]))
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-testid="transcript-line"]')
    if (!playable || !row || row !== e.target) return
    const i = shownLines.findIndex((l) => key(l) === row.dataset.key)
    if (i < 0) return
    const go = (j: number) => { const next = rowOf(key(shownLines[Math.max(0, Math.min(shownLines.length - 1, j))])); next?.focus(); next?.scrollIntoView({ block: 'nearest' }) }
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); go(0) }
    else if (e.key === 'End') { e.preventDefault(); go(shownLines.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); follow(); player.current?.playFrom(shownLines[i].startMs) }
  }

  const typed = query.trim()
  // what is being said joins the bubble it carries on; not while searching
  const grouped = useMemo(() => timeline.map(run => ({ ...run, source: run, lines: typed ? run.lines.filter(l => !('live' in l) && filterLines([l], typed).length) : run.lines })).filter(run => run.lines.length), [timeline, typed])
  /** the line being played is on screen, not left out by the search */
  const playingShown = useMemo(() => !!shownKey && shownLines.some((l) => key(l) === shownKey), [shownKey, shownLines])
  const Surface = inline ? 'section' : 'aside'

  const tools = (
      <div className="transcript-toolbar">
        <label className="transcript-search-field" data-pointer={animateSearch} onPointerDown={() => { pointerSearch.current = true }}>
          <SearchIcon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
          <input data-testid="transcript-search" value={query} onFocus={() => { setAnimateSearch(pointerSearch.current); pointerSearch.current = false }} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search')} aria-label={t('Search the transcript')} spellCheck={false} />
        </label>
        {!inline && onClose && <div className="transcript-actions"><button data-testid="transcript-close" onClick={onClose} aria-label={t('Hide transcript')} title={t('Hide transcript')} className="ghost-btn !p-1.5"><ChevronDown size={15} aria-hidden="true" /></button></div>}
      </div>
  )

  return (
    <Surface style={{ '--playback-inset': `${playbackInset}px` } as CSSProperties} data-testid="transcript-panel" aria-label={t('Transcript')} onKeyDown={(e) => { if (!inline && e.key === 'Escape') { e.stopPropagation(); onClose?.() } }}
      className={inline ? 'transcript-inline' : 'chat-in pointer-events-auto absolute inset-x-0 bottom-1 z-20 mx-auto flex h-[min(44vh,480px)] w-[min(720px,calc(100%-48px))] flex-col rounded-xl border border-line bg-float shadow-[var(--shadow)]'}>
      {active && (toolbar ? createPortal(tools, toolbar) : tools)}
      {restoreError && <p role="alert" className="px-4 text-xs text-muted">{t("Couldn't save your changes")}</p>}
      <div className="transcript-scroll-wrap relative flex min-h-0 flex-1 flex-col">
        <ScrollFade enabled={active && loaded}><ol data-loaded={loaded} data-loading-phase={loadingPhase} data-testid="transcript" ref={list} onScroll={onScroll} onWheel={theirs} onTouchStart={theirs} onPointerDown={theirs} onKeyDownCapture={theirs} onKeyDown={onKeyDown} className="loading-content transcript-loading-content flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4 pt-2 text-sm leading-[1.55]">
          {loadingPhase !== 'ready' && <li className="loading-placeholder"><Loading layout="transcript" /></li>}
          {loaded && allLines.length === 0 && liveSaid.length === 0 && <li data-testid="transcript-empty" className="note-empty empty-state"><div className="empty-state-content"><div className="empty-tile"><AudioLines size={28} strokeWidth={1.5} aria-hidden="true" /></div>{t('Nothing heard yet.')}</div></li>}
          {allLines.length > 0 && grouped.length === 0 && <li data-testid="transcript-none" className="note-empty">{t('Nothing found for “{query}”.', { query: typed })}</li>}
          {grouped.map(run => <Fragment key={key(run.lines[0])}>
            {run.echo && <li className="transcript-echo" data-testid="transcript-echo">
              <span>{echoedLinesLabel(run.lines.length)}</span><span aria-hidden="true">·</span>
              <button type="button" data-testid="transcript-echo-toggle" aria-label={`${echoedLinesLabel(run.lines.length)} · ${isExpanded(run.source) ? t('Hide') : t('Show')}`} aria-expanded={isExpanded(run.source)} onClick={() => toggleEcho(run.source)}>{isExpanded(run.source) ? t('Hide') : t('Show')}</button>
            </li>}
            {(!run.echo || isExpanded(run.source)) && turns(run.lines).map((turn) => {
            const me = turn[0].track === 'me', first = turn[0]
            const color = me || !('speakerColor' in first) ? undefined : first.speakerColor
            // a name comes with the first final line; until then its place is kept, so nothing moves when it shows
            const named = turn.some((x) => !('live' in x))
            return (
              <li key={key(first)} data-testid="transcript-turn" data-track={first.track} className={`transcript-turn flex flex-col gap-[5px] ${me ? 'items-end' : 'items-start'}`}>
                {/* the other side's name heads their turn; the mic's side needs none, its bubbles sit at the end */}
                <p className={me ? 'sr-only' : 'turn-head flex items-baseline gap-2 px-1 text-xs'}>
                  <span data-testid="transcript-who" data-color={color} data-folder-color={color === undefined ? undefined : SPEAKER_COLORS[color]} className={`line-who font-medium ${me ? '' : 'text-muted'} ${named ? 'name-in' : 'invisible'}`}>{who(first)}</span>
                  <time className="turn-time tabular-nums text-muted">{clock(first.startMs)}</time>
                </p>
                {bubbles(turn).map((b) => (
                  <p key={key(b[0])} data-testid="transcript-bubble" data-track={first.track} data-echo={run.echo || undefined} dir="auto" className={`bubble ${me ? 'bubble-me' : 'bubble-them'}`}>
                    {b.map((x, i) => {
                      if ('live' in x) return <Fragment key="live">{i > 0 && ' '}<LiveWords said={x.live} /></Fragment>
                      const k = key(x)
                      return (
                        <Fragment key={k}>{i > 0 && ' '}
                          <Row line={x} focused={k === focusedKey} name={who(x)} query={typed}
                            playing={k === shownKey} playable={playable} focusable={k === tabKey} arrived={live.current.has(k) ? (previewed(x) ? 'settle' : 'fade') : null} onPlay={onPlay} onFocusLine={setFocusKey} onRestore={x.id === undefined ? undefined : restore} />
                        </Fragment>
                      )
                    })}
                  </p>
                ))}
              </li>
            )
          })}</Fragment>)}
        </ol></ScrollFade>
        {recording && behind && (
          <button data-testid="transcript-latest" onClick={toLatest} className="absolute bottom-3 start-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-float px-3 py-1 text-xs shadow-[var(--shadow)] rtl:translate-x-1/2">
            <ArrowDown size={12} aria-hidden="true" />{t('Latest')}
          </button>
        )}
        {!recording && audioOn && away && playingShown && (
          <button data-testid="transcript-follow" onClick={backToPlaying} className="absolute bottom-3 start-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md border border-line bg-float px-3 py-1 text-xs shadow-[var(--shadow)] rtl:translate-x-1/2">
            <ArrowDown size={12} aria-hidden="true" className="follow-arrow" data-up={away === 'up'} />{t('Back to playing')}
          </button>
        )}
      </div>
      {active && playable && <div ref={playbackDock} className="transcript-player-dock"><Player ref={player} id={id} tracks={tracks} onTime={onTime} onPlaying={setAudioOn} /></div>}
    </Surface>
  )
}
