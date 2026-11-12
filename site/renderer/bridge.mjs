import { sceneAt, duration, timing, mine, summary, question } from './timeline.mjs'
// Clamp the midnight edge so the demo still belongs to the visitor’s current day.
const loadedAt=Date.now(), dayStart=new Date(loadedAt).setHours(0,0,0,0)
// An in-memory fixture drives the real renderer. Nothing reaches IPC, storage or a device.
export const meeting = {
  id: 'sample-meeting', title: 'Launch planning', startedAt: Math.max(loadedAt-720000,dayStart),
  endedAt: null, durationMs: 720000, state: 'recording', eventId: null, app: null,
  language: 'english', titleSource: 'user', attendees: ['Kara Moore', 'Ray Mones', 'Lincoln Park', 'Charlotte Goode'].map(name => ({ name })),
}
export const folders = [
  { id: 'launch', name: 'Launch', color: 'violet' },
  { id: 'hiring', name: 'Hiring', color: 'teal' },
  { id: 'customer-calls', name: 'Customer calls', color: 'amber' },
].map((folder,position)=>({...folder,icon:'folder',createdAt:meeting.startedAt,position}))
const notes = { meetingId: meeting.id, mine, enhanced: null, edited: false, status: 'idle', draft: '', peopleChanged: false, saves: { mine: { revision: 0, status: 'saved' }, enhanced: { revision: 0, status: 'saved' } } }
export const sources = [{ n:1, meetingId:meeting.id, title:meeting.title, startedAt:meeting.startedAt, atMs:721500,
  excerpt:'Ray Mones: Support has the checklist. We can publish Tuesday.\nLincoln Park: I’ll send the announcement on Wednesday morning.',
  transcript:{speakers:['Kara Moore','Ray Mones','Lincoln Park'],lines:[
    {track:'them',speaker:'Ray Mones',text:'Support has the checklist. We can publish Tuesday.',startMs:721500},
    {track:'them',speaker:'Lincoln Park',text:'I’ll send the announcement on Wednesday morning.',startMs:725200},
  ]},
}]
const context = [{kind:'meeting',id:meeting.id,title:meeting.title,startedAt:meeting.startedAt}]
export const chat = { id:'sample-conversation', title:'Launch date', chips:context, draft:'', draftChips:[], firstChips:null, turns:[], waitsForMeeting:false, waitsForModel:false }
export const fragment = new URLSearchParams(location.search).get('fragment')
const noop = () => {}, off = () => noop, read = value => async () => structuredClone(value)
const events = Object.fromEntries(['widget', 'level', 'segment', 'speakers', 'partial', 'reset', 'meeting', 'notes', 'chat'].map(key => {
  const listeners = new Set()
  return [key, { on: callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, emit: value => listeners.forEach(callback => callback(structuredClone(value))) }]
}))
export const onReset = events.reset.on
const still = new URLSearchParams(location.search).get('still')
const requested = Number(still)
let time = still === null ? 0 : Math.max(0, Math.min(duration, still === '' || !Number.isFinite(requested) ? 33 : requested)), playing = false, transcript = sceneAt(time).transcript
let transcriptSignature = JSON.stringify(transcript), notesSignature = '', chatSignature = '', frame = 0, requestedTab, typedMine, typedEditor
notes.mine = typedMine = sceneAt(time).mine
const saveMine = (_id,text,revision) => { notes.mine=text; notes.saves.mine={revision,status:'saved'}; return structuredClone(notes.saves.mine) }
const widget = () => meeting.state !== 'recording' ? null : ({ kind: 'recording', meetingId: meeting.id, title: meeting.title, elapsedMs: 720000 + (time >= timing.resume ? 0 : time) * 1000, at: Date.now(), note: null })
window.yogurt = {
  platform: 'darwin', fake: true,
  setup: { state: read({}), onState: off },
  widget: { state: async () => widget(), onState: events.widget.on, onLevel: events.level.on },
  meetings: { get: read(meeting), onChange: events.meeting.on, stop: async () => {}, resume: async () => { document.documentElement.dataset.resumeClicked='true'; return {id:meeting.id} } },
  notes: { get: read(notes), onChange: events.notes.on, onFlushRequest: off, keptEdits: noop, setMine: async (...args) => saveMine(...args), setEnhanced: read({revision:0,status:'failed'}), flushSync: (id,side,text,revision) => side==='mine' ? saveMine(id,text,revision) : {revision,status:'saved'} },
  transcript: { get: async () => structuredClone(transcript), onSpeakers: events.speakers.on, onSegment: events.segment.on, onPartial: events.partial.on },
  conversations: { current:read(chat.id), get:read(chat), onChange:events.chat.on, targets:read(context), warm:noop,
    draft:async (_id,value)=>{chat.draft=value},
    ask:async (_id,q)=>{if(q===question)document.documentElement.dataset.questionSent='true'; chat.draft=''; return chat.id},
    stop:async()=>{},
  },
  settings: { get: read({ theme: 'dark', locale: 'en', systemLocale: 'en', language: '', spoken: 'en', myName: 'You', macName: 'You', recordingReminder: false }), onLanguage: off },
  audio: { tracks: read([]), mics: read({ devices: [], choice: null, using: 'Mac microphone', defaultName: 'Mac microphone' }), onMics: off },
  folders: { suggestion:read(null), of: read([folders[0]]), list: read(folders), onChange: off },
  onboarding: { nudge: read([]) }, nav: { go: noop, takeAsk: read(false), onAsk: off }, share: { copy: read('failed'), save: read('cancelled') },
}
// The embedded demonstration must never steal keyboard focus from the marketing page.
HTMLElement.prototype.focus = noop
if (still !== null) document.documentElement.dataset.still = ''
const interval = window.setInterval.bind(window)
window.setInterval = (callback, ms, ...args) => interval(() => { if (playing && still === null) callback(...args) }, ms)
const target = id => document.querySelector(`[data-testid="${id}"]`)
const click = (button, pointer = true) => button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: pointer ? 1 : 0 }))
function prepareEditor(s) {
  const editor = target('note-mine')?.editor
  if(editor && (typedEditor !== editor || typedMine !== s.mine)) {
    typedEditor=editor
    typedMine=s.mine
    editor.commands.setContent({type:'doc',content:[{type:'bulletList',content:s.mine.split('\n').map(line=>({type:'listItem',content:[{type:'paragraph',content:line.slice(2)?[{type:'text',text:line.slice(2)}]:[]}]}))}]})
    let end = 0
    editor.state.doc.descendants((node, pos) => { if (node.isTextblock) end = pos + 1 + node.content.size })
    editor.commands.setTextSelection(end)
  }
}
function controls(s) {
  document.activeElement?.blur()
  const tab = target(s.tab)
  // One activation per target lets the app's asynchronous view transition complete.
  if ((still !== null || s.tab !== 'note-summary-tab') && tab && tab !== requestedTab) { requestedTab = tab; if (tab.getAttribute('aria-selected') !== 'true') click(tab, time >= timing.notes) }
  if (time >= timing.ask && time < timing.close && target('chat-open')?.getAttribute('aria-expanded') !== 'true') click(target('chat-open'))
  if(time >= timing.close && target('chat-close') && !document.documentElement.dataset.chatClosed) { click(target('chat-close')); document.documentElement.dataset.chatClosed='true' }
  if(time >= timing.resume && !document.documentElement.dataset.resumeClicked) click(target('note-resume'))
  prepareEditor(s)
  document.documentElement.dataset.typing = String(time >= timing.type && time < timing.typed)
  const input = target('chat-input')
  if (input && time < timing.send && input.value !== s.question) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, s.question)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // Native form activation is disabled by the sandbox; only notify React's in-memory handler.
  if (time >= timing.send && time < timing.close && !document.documentElement.dataset.questionSent) {
    if (input && input.value !== question) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, question)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (target('chat-send') && !target('chat-send').disabled) target('chat-box')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
}
// Move, settle, then click the actual control. The app itself selects Summary after Finish.
const clicks = [
  {id:'note-notes-tab',start:timing.notes-1.2,at:timing.notes},
  {id:'note-stop',start:timing.finish-1.3,at:timing.finish},
  {id:'chat-open',start:timing.ask-1.3,at:timing.ask},
  {id:'chat-send',start:timing.send-1.1,at:timing.send},
  {id:'chat-close',start:timing.close-1.1,at:timing.close},
  {id:'note-resume',start:timing.resume-1.1,at:timing.resume},
  {id:'note-transcript-toggle',start:timing.transcript-1.1,at:timing.transcript},
  {id:'home',start:timing.transcript+.2,at:duration},
]
let cursorCue, cursorMotion, cursorStart=0
function moveCursor(cursorTime = time) {
  const cursor = document.querySelector('.marketing-cursor')
  if (!cursor) return
  const home = { x:(window.innerWidth || 1000)*.75-4, y:(window.innerHeight || 608)*.82-3 }
  if (!cursorMotion && !cursorCue) cursor.style.transform=`translate(${home.x}px,${home.y}px)`
  const cue = clicks.findLast(c => cursorTime >= c.start)
  cursor.style.opacity = cue && cursorTime < cue.at+(cue.id==='note-notes-tab'?.2:.35) && (still === null || cue.id !== 'home') ? '1' : '0'
  cursor.dataset.clicking = String(!!cue && cue.id !== 'home' && cursorTime >= cue.at && cursorTime < cue.at+.15)
  if (!cue) return
  if (cue !== cursorCue) {
    let {x,y} = home
    if (cue.id !== 'home') {
      const button = target(cue.id)
      if (!button) return
      const r = button.getBoundingClientRect()
      if (!r.width || !r.height) return
      x=r.x+r.width*.6-4; y=r.y+r.height*.6-3
    }
    let from = cursor.getBoundingClientRect()
    if (cue.id === 'note-stop') {
      const editor = target('note-mine')?.editor
      if (!editor) return
      const caret = editor.view.coordsAtPos(editor.state.selection.to)
      if (caret.bottom <= caret.top) return
      // The pointer returns beside the completed text, while still hidden.
      from = { x:caret.left+10, y:caret.bottom+8 }
    }
    const travel = Math.max(240,Math.hypot(x-from.x,y-from.y)/.6)
    cursorMotion?.cancel()
    cursorMotion=cursor.animate([{transform:`translate(${from.x}px,${from.y}px)`},{transform:`translate(${x}px,${y}px)`}],{duration:travel,easing:'cubic-bezier(.45,0,.25,1)',fill:'both'})
    cursorMotion.pause(); cursorCue=cue
    // Late-mounted controls start where the pointer is, never partway through a new path.
    cursorStart=still !== null ? cue.start : Math.max(cue.start,cursorTime-1/60)
  }
  cursorMotion.currentTime = Math.max(0,(cursorTime-cursorStart)*1000)
}

export function setTime(seconds, bands = [.4, .65, .5]) {
  const reset = seconds < time
  time = seconds
  const s = sceneAt(time)
  prepareEditor(s)
  moveCursor()
  if (reset) { delete document.documentElement.dataset.chatClosed; delete document.documentElement.dataset.resumeClicked; delete document.documentElement.dataset.questionSent }
  if (time >= timing.finish && time < timing.resume && meeting.state === 'recording') click(target('note-stop'))
  if (meeting.state !== s.state) { meeting.state = s.state; meeting.endedAt = s.state !== 'recording' ? meeting.startedAt+720000+timing.finish*1000 : null; events.meeting.emit() }
  // The same saved-line set drives initial playback and rewind.
  transcript = s.transcript
  if (JSON.stringify(transcript) !== transcriptSignature) { transcriptSignature = JSON.stringify(transcript); transcript.filter(line=>!line.hidden).forEach(line => events.segment.emit(line)); events.speakers.emit(meeting.id) }
  const liveWords = s.partial.split(' ').filter(Boolean).map((text, i) => ({ text, startMs: s.partialStart+i*200, endMs: s.partialStart+i*200+150 }))
  events.partial.emit({ meetingId: meeting.id, track: 'them', startMs: s.partialStart, text: s.partial, words: liveWords })
  Object.assign(notes, { status: s.status, enhanced: s.status === 'done' ? summary : null, draft: s.draft })
  if (JSON.stringify(notes) !== notesSignature) { notesSignature = JSON.stringify(notes); events.notes.emit(notes) }
  chat.turns = time < timing.send || time >= timing.resume ? [] : [{id:1,question,answer:s.answer+(time>=timing.answered?'[1]':''),status:time < timing.answered ? 'answering' : 'done',step:time<timing.answer?{kind:'loading'}:{kind:'reading',title:meeting.title},sources}]
  chat.firstChips = chat.turns.length ? context : null
  if (JSON.stringify(chat) !== chatSignature) { chatSignature = JSON.stringify(chat); events.chat.emit(chat) }
  if (time < 1.5 && still === null) bands = [.45 + .2*Math.sin(time*9), .55 + .18*Math.sin(time*13)]
  const level = Array.isArray(bands) ? Math.max(0, ...bands.slice(0, 3).map(value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)) : 0
  const levels = { me: meeting.state === 'recording' ? level : 0, them: meeting.state === 'recording' ? level : 0 }
  events.level.emit(levels)
  events.widget.emit(widget())
  if (reset && !target('note-transcript-toggle')) events.reset.emit()
  controls(s)
  cancelAnimationFrame(frame)
  // A seek can open a tab, dialog and composer together; let the real components mount first.
  let remaining = 6
  const settle = () => { controls(sceneAt(time)); events.level.emit(levels); events.partial.emit({ meetingId: meeting.id, track: 'them', startMs: s.partialStart, text: s.partial, words: liveWords }); if (--remaining) frame = requestAnimationFrame(settle) }
  frame = requestAnimationFrame(settle)
}
export function ready() {
  const finish = () => {
    if (!target('note-transcript-toggle')) return
    if (time === 0) {
      controls(sceneAt(time))
      if (document.querySelectorAll('[data-testid=transcript-who]').length < sceneAt(0).transcript.filter(line=>!line.hidden).length) return
    }
    observer.disconnect()
    setTime(time)
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.documentElement.dataset.ready = 'true'
      window.parent.postMessage({ type: 'yogurt-hero-ready', duration }, location.origin)
    }))
  }
  const observer = new MutationObserver(finish)
  observer.observe(document.body, { childList: true, subtree: true })
  finish()
  return () => observer.disconnect()
}
window.addEventListener('message', event => {
  if (fragment || event.source !== window.parent || event.origin !== location.origin) return
  if (event.data?.type === 'yogurt-hero-cursor' && Number.isFinite(event.data.seconds)) moveCursor(Math.max(0,Math.min(duration,event.data.seconds)))
  if (event.data?.type === 'yogurt-hero-time' && Number.isFinite(event.data.seconds)) setTime(Math.max(0, Math.min(duration, event.data.seconds)), event.data.bands)
  if (event.data?.type === 'yogurt-hero-playing' && typeof event.data.playing === 'boolean') {
    playing = event.data.playing
    document.documentElement.dataset.playing = String(playing)
  }
})

export function fragmentChat(turn) { chat.turns=turn?[{id:1,...turn,sources}]:[];chat.firstChips=context;events.chat.emit(chat) }
export function fragmentTranscript(lines, partial) { transcript=lines; for(const line of lines)events.segment.emit(line); events.speakers.emit(meeting.id); events.partial.emit({meetingId:meeting.id,...partial}) }
