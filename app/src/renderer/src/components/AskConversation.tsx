import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, AtSign, Check, FileText, Folder, Maximize2, Square, X } from 'lucide-react'
import { attachContext, mentionAt, type ContextTarget } from '../../../shared/askContext'
import type { AskStep, ConversationTurn, ConversationView, LibrarySource } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { stepText, STEP_EVERY_MS } from '../../../shared/askStep'
import { dayLabel } from '../dates'
import { useSmoothText } from '../useSmoothText'
import { AnswerText } from './AnswerText'
import { Copy } from './Icons'
import { Loading } from './Loading'
import { LoadingContent } from './LoadingContent'
import { NotesModelWait } from './NotesModelWait'
import { ThinkingDots } from './ThinkingDots'
import { ConversationActions } from './ConversationActions'
import { ScrollFade } from './ScrollFade'
import { rememberedScroll, useScrollMemory } from '../useScrollMemory'
import { AskContext, chipTitle } from './AskContext'
import { useFollowLatest } from '../useFollowLatest'
import { Swap, SwapText } from './Swap'

const drafts = new Map<string, string>()
const starters = (chips: ContextTarget[], recording: boolean) => chips.length === 1 && chips[0].kind === 'meeting'
  ? recording ? [t('What did I just miss?'), t('Sum up the meeting so far'), t('What should I ask next?')]
    : [t('What was decided?'), t('What are my next steps?'), t('What questions are still open?')]
  : chips.length ? [t('What was decided?'), t('What are my next steps?'), t('What questions are still open?')]
    : [t('What are my next steps this week?'), t('What did we decide last week?'), t('Catch me up on yesterday')]

/** One composer and thread for both the page and the note panel. Draft writes never wait for the model. */
export function AskConversation({ id, initial, home = false, panel = false, recording = false, onSelect, onSource, onDeleted, onClose, onExpand }: {
  id: string; initial?: ConversationView; home?: boolean; panel?: boolean; recording?: boolean; onDeleted: () => void; onClose?: () => void; onExpand?: () => void; onSelect: (id: string) => void; onSource: (source: LibrarySource, match?: string) => void
}) {
  const [chat, setChat] = useState(initial)
  const [text, setText] = useState(drafts.get(id) ?? initial?.draft ?? '')
  const [error, setError] = useState(false)
  const [sending, setSending] = useState(false)
  const [changing, setChanging] = useState(false)
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [targetResults, setTargetResults] = useState<{ query: string; items: ContextTarget[] }>()
  const targets = targetResults?.items ?? []
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const focusAfterRemove = useRef(false)
  const scrollKey = `conversation/${id}`
  const scroll = useScrollMemory<HTMLDivElement>(scrollKey, !!chat)
  const content = useRef<HTMLDivElement>(null)
  const follow = useFollowLatest(scroll, content, !!chat, rememberedScroll(scrollKey) === undefined)
  const prefix = panel ? 'chat' : 'chat-page'
  useEffect(() => {
    if (!id) return
    let active = true, revision = 0
    setError(false); setMention(undefined)
    const off = window.yogurt.conversations.onChange(v => { if (v.id === id) { revision++; setChat(v) } })
    const load = (first = false) => {
      const request = ++revision
      void window.yogurt.conversations.get(id).then(v => {
        if (!active) return
        if (!v) throw new Error('Conversation not found')
        if (request === revision) setChat(v)
        if (first) {
          if (!initial) setText(drafts.get(id) ?? v.draft)
        }
      }).catch(() => { if (active && request === revision) setError(true) })
    }
    const offMeetings = window.yogurt.meetings.onChange(() => load())
    const offFolders = window.yogurt.folders.onChange(() => load())
    load(true)
    return () => { active = false; off(); offMeetings(); offFolders() }
  }, [id])
  useEffect(() => {
    let active = true
    if (!mention) { setTargetResults(undefined); setSelected(0); return }
    // Keep the last completed search visible until the replacement is ready.
    void window.yogurt.conversations.targets(mention.query).then(items => {
      if (!active) return
      setTargetResults({ query: mention.query, items: items.filter(c => ![...(chat?.chips ?? []), ...(chat?.draftChips ?? [])].some(x => x.kind === c.kind && x.id === c.id)) }); setSelected(0)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [mention?.query, !!mention, chat?.chips, chat?.draftChips])
  // about exactly one meeting: main reads it in now, so the first question only reads itself
  const scope = chat ? attachContext(chat.chips, chat.draftChips) : []
  const single = scope.length === 1 && scope[0].kind === 'meeting' ? scope[0].id : undefined
  const warm = () => { if (single) window.yogurt.conversations.warm(id) }
  useEffect(warm, [id, single])
  useEffect(() => { document.getElementById(`${prefix}-context-${selected}`)?.scrollIntoView({ block: 'nearest' }) }, [selected, targets])
  useLayoutEffect(() => {
    if (!changing && focusAfterRemove.current) { focusAfterRemove.current = false; input.current?.focus() }
  }, [changing, chat])
  const turns = chat?.turns ?? [], last = turns.at(-1)
  const answering = last?.status === 'waiting' || last?.status === 'answering'
  const busy = !chat || sending || changing || answering
  const unsent = (chat ? chat.firstChips === null : home || panel) && !turns.length
  const landing = home || (!panel && unsent)
  const chips = chat ? attachContext(chat.chips, chat.draftChips) : []
  const saveText = (value: string) => {
    setText(value); drafts.set(id, value)
    void window.yogurt.conversations.draft(id, value).then(() => { if (drafts.get(id) === value) drafts.delete(id) }).catch(() => setError(true))
  }
  const detectMention = (value: string, caret: number) => {
    setMention(mentionAt(value, caret))
  }
  const context = async (chips: ContextTarget[]) => {
    setChanging(true); setError(false)
    try { await window.yogurt.conversations.context(id, chips) }
    catch { setError(true); throw new Error('Context was not saved') }
    finally { setChanging(false) }
  }
  const insert = (c: ContextTarget) => {
    if (!mention || busy || !chat) return
    const range = mention
    void context([...chat.draftChips, c]).then(() => {
      const value = text.slice(0, range.start) + text.slice(range.end)
      saveText(value); setMention(undefined)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(range.start, range.start) })
    }).catch(() => {})
  }
  const remove = async (chip: ContextTarget) => {
    if (busy) return
    focusAfterRemove.current = true
    setChanging(true); setError(false)
    try { await window.yogurt.conversations.removeContext(id, chip) }
    catch { focusAfterRemove.current = false; setError(true) }
    finally { setChanging(false) }
  }
  // Sending from the box (Enter, the send button or a starter) keeps the person in it; the button turns into Stop and starters go. A disabled field would drop focus, so it is read-only while saving.
  const keepTyping = () => { const from = document.activeElement; if (from === document.body || from?.closest('.ask-box, .ask-starters')) input.current?.focus({ preventScroll: true }) }
  const send = (q: string) => {
    if (!q.trim() || busy) return
    keepTyping()
    follow.resume(); setSending(true); setError(false); setMention(undefined)
    void window.yogurt.conversations.ask(id, q).then(made => {
      if (!made) throw new Error('Question was not saved')
      setText(''); drafts.delete(id)
      if (home) onSelect(made)
    }).catch(() => { saveText(q); setError(true) }).finally(() => setSending(false))
  }
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (mention && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') setMention(undefined)
      else if (e.key === 'Enter') { if (targets[selected]) insert(targets[selected]) }
      else setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + targets.length) % (targets.length || 1))
    } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text) }
  }
  const fresh = () => {
    if (!chat || changing) return
    void window.yogurt.conversations.current(attachContext(chat.chips, chat.draftChips), true).then(onSelect).catch(() => setError(true))
  }
  const startersHidden = !panel && !!text
  const suggestions = unsent && (landing || panel) && (!panel || !text) && <div data-testid={panel ? 'chat-suggestions' : 'chat-starters'} aria-hidden={startersHidden || undefined} inert={startersHidden} className={`ask-starters${panel ? '' : ' ask-home-starters'}`}>
    {starters(chat ? attachContext(chat.chips, chat.draftChips) : [], recording).map(q => <button type="button" key={q} title={q} data-testid={panel ? 'chat-suggestion' : 'chat-starter'} disabled={busy || startersHidden} onClick={() => send(q)}>{q}</button>)}
  </div>
  return <div data-testid={landing ? "chat-empty" : undefined} aria-busy={last?.status === 'answering'} className={`ask-conversation${landing ? ' ask-landing' : ''}`}>
    {landing ? <h1 className="ask-home-title">{t('Ask about your meetings')}</h1> : <header className="ask-conversation-head">
      <h2 id={panel ? 'meeting-chat-title' : undefined} title={[chat?.title || t('New chat'), ...(chat?.chips.map(chipTitle) ?? [])].join('\n')}>{chat?.title || t('New chat')}</h2>
      <div className="ask-header-actions">
        {chat && <ConversationActions id={id} title={chat.title} onNew={fresh} onDeleted={onDeleted} />}
        {onExpand && <button type="button" data-testid="chat-expand" className="chat-icon" onClick={onExpand} aria-label={t('Open in Ask')} title={t('Open in Ask')}><Maximize2 size={15} aria-hidden="true" /></button>}
        {onClose && <button type="button" data-testid="chat-close" className="chat-icon" onClick={onClose} aria-label={t('Close')} title={t('Close')}><X size={16} aria-hidden="true" /></button>}
      </div>
    </header>}
    <div className="ask-thread-wrap">
      <ScrollFade><div className={`ask-thread${panel ? " chat-history" : ""}${unsent ? ' ask-thread-empty' : ''}`} ref={scroll}>
        <div ref={content} className="ask-thread-content">
        <LoadingContent pending={!chat && !error} skeleton={<Loading layout="chat" testId="chat-thread-loading" />}>
        {!landing && turns.map(turn => <Turn key={turn.id} turn={turn} chat={chat!} panel={panel} onSource={onSource} onRetry={() => send(turn.question)} />)}
        {panel && suggestions}</LoadingContent>
        </div>
      </div></ScrollFade>
      {follow.behind && <button className="chat-latest" data-testid="chat-latest" aria-label={t('Back to latest')} onClick={follow.latest}><ArrowDown size={15} /></button>}
    </div>
    <div className={`ask-composer${panel ? ' chat-composer' : ''}`}>
      {error && <p data-testid={panel ? "chat-send-error" : "chat-page-error"} role="alert" className="chat-error">{t("Couldn't save your changes")}</p>}
      <LoadingContent pending={!chat && !error} onReady={() => { if (chat) input.current?.focus({ preventScroll: true }) }} testId={landing ? "chat-loading" : undefined}><form className="ask-box" data-busy={busy || undefined} data-testid={`${prefix}-box`} onSubmit={e => { e.preventDefault(); send(text) }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMention(undefined) }}>
        <span className="ask-border" aria-hidden="true" />
        <AskContext chips={chips} disabled={busy} onRemove={remove} />
        <div className="ask-field">
        <textarea ref={input} id={panel ? 'meeting-question' : 'library-question'} data-testid={`${prefix}-input`} rows={1} maxLength={4000}
          placeholder={panel ? t('Ask anything') : t('Ask about your meetings')} aria-label={panel ? t('Ask anything') : t('Ask about your meetings')} value={text} disabled={!chat} readOnly={sending || changing}
          role="combobox" aria-autocomplete="list" aria-expanded={!!mention} aria-controls={mention ? `${prefix}-contexts` : undefined}
          aria-activedescendant={mention && targets[selected] ? `${prefix}-context-${selected}` : undefined}
          onChange={e => { saveText(e.target.value); detectMention(e.target.value, e.target.selectionStart) }}
          onClick={e => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)} onFocus={warm} onKeyDown={key} />
        <div className="ask-box-actions">
          <button type="button" className="ask-toolbar-button" disabled={busy} aria-label={t('Add a meeting or folder')} title={t('Add a meeting or folder')} onClick={() => {
            const caret = input.current?.selectionStart ?? text.length
            const token = caret && !/\s/.test(text[caret - 1]) ? ' @' : '@'
            const value = text.slice(0, caret) + token + text.slice(caret)
            saveText(value); detectMention(value, caret + token.length)
            input.current?.focus(); requestAnimationFrame(() => input.current?.setSelectionRange(caret + token.length, caret + token.length))
          }}><AtSign size={16} aria-hidden="true" /></button>
          {answering ? <button type="button" data-testid={`${prefix}-stop`} className="ask-toolbar-button ask-stop" aria-label={chat?.waitsForModel ? t('Cancel question') : t('Stop')} title={chat?.waitsForModel ? t('Cancel question') : t('Stop')} onClick={() => { keepTyping(); window.yogurt.conversations.stop(id) }}><Square size={10} fill="currentColor" /></button>
            : <button type="submit" data-testid={`${prefix}-send`} className="ask-toolbar-button ask-send" disabled={busy || !text.trim()} aria-label={t('Ask')}><span className="orb-material" aria-hidden="true" /><ArrowUp size={16} /></button>}
        </div>
        </div>
        {mention && <div className="ask-picker" id={`${prefix}-contexts`} role="listbox" aria-label={t('Add context')}>
          {(['meeting', 'folder'] as const).map(kind => targets.some(c => c.kind === kind) && <div key={kind} role="group" aria-label={kind === 'meeting' ? t('Meetings') : t('Folders')}>
            <h3>{kind === 'meeting' ? t('Meetings') : t('Folders')}</h3>
            {targets.map((c, i) => c.kind === kind && <button type="button" role="option" aria-selected={selected === i} id={`${prefix}-context-${i}`} key={`${c.kind}:${c.id}`}
              onMouseDown={e => e.preventDefault()} onClick={() => insert(c)}>
              {kind === 'meeting' ? <FileText size={14} /> : <Folder size={14} />}<span>{chipTitle(c)}</span>{c.startedAt && <small>{dayLabel(c.startedAt)}</small>}
            </button>)}
          </div>)}
          {!targetResults && !error && <p role="status">{t('Loading…')}</p>}
          {targetResults && !targets.length && <p>{t('Nothing found for “{query}”.', { query: targetResults.query })}</p>}
        </div>}
      </form></LoadingContent>
    </div>
    {!panel && suggestions}
    <p data-testid={`${prefix}-announce`} className="sr-only" aria-live="polite">{last?.status === 'done' ? last.answer : ''}</p>
  </div>
}
function Turn({ turn, chat, panel, onSource, onRetry }: { turn: ConversationTurn; chat: ConversationView; panel: boolean; onSource: (s: LibrarySource, match?: string) => void; onRetry: () => void }) {
  const live = turn.status === 'answering', answer = useSmoothText(turn.answer, live)
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false)
  const prefix = panel ? 'chat' : 'chat-page'
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) }, [copied])
  return <div data-testid={`${prefix}-turn`} data-status={turn.status} className="ask-turn">
    <p className="ask-question" data-testid={`${prefix}-question`}>{turn.question}</p>
    {(turn.status === 'waiting' || live && !answer) && (chat.waitsForModel && turn.status === 'waiting'
      ? <NotesModelWait downloading={percent => <p role="status" className="text-sm text-muted">{t("Waiting for Yogurt's AI to finish downloading ({percent}). Your answer comes as soon as it's ready.", { percent })}</p>}><p role="status" className="text-sm text-muted">{t('Getting ready to answer. Yogurt is still setting up.')}</p></NotesModelWait>
      : <p className="chat-progress" role="status">{chat.waitsForMeeting && turn.status === 'waiting' ? t('Yogurt will answer once the meeting ends.') : <><ThinkingDots /><StepText step={turn.status === 'waiting' ? undefined : turn.step} /></>}</p>)}
    {answer && <div data-testid={`${prefix}-answer`} dir="auto" data-streaming={live || undefined} className={`note-prose chat-answer${live ? ' stream-caret' : ''}`}><AnswerText md={answer} live={live} sources={turn.sources} onSource={onSource} /></div>}
    {answer && !live && <div className="chat-answer-actions"><button className="chat-copy-action" data-testid="chat-copy-answer" aria-label={copied ? t('Copied') : t('Copy answer')} onClick={() => {
      void navigator.clipboard.writeText(turn.answer).then(() => { setCopied(true); setFailed(false) }).catch(() => setFailed(true))
    }}><Swap show={copied ? 'done' : 'copy'} options={{ copy: <Copy size={13} />, done: <Check size={13} /> }} /><SwapText text={copied ? t('Copied') : t('Copy')} widest={t('Copied')} /></button><span role="status" className={failed ? 'text-danger' : 'sr-only'}>{failed ? t("Couldn't copy. Try again.") : copied ? t('Copied') : ''}</span></div>}
    {turn.status === 'stopped' && <p className="text-xs text-muted">{answer ? t('Stopped') : t('Stopped before answering')}</p>}
    {turn.status === 'failed' && <p role="alert">{t("Yogurt couldn't answer that.")} <button className="ghost-btn" onClick={onRetry}>{t('Try again')}</button></p>}
  </div>
}

/** The step an answer is on; one that runs long says it is still on it every few seconds */
function StepText({ step }: { step?: AskStep }) {
  const [tick, setTick] = useState(0)
  const key = JSON.stringify(step ?? null)
  useEffect(() => {
    setTick(0)
    const timer = setInterval(() => setTick(n => n + 1), STEP_EVERY_MS)
    return () => clearInterval(timer)
  }, [key])
  const text = stepText(step, tick)
  return <span key={text} data-testid="chat-step" className="chat-step">{text}</span>
}
