import type { WidgetLayout, WidgetSurface } from './widgetMorph'
import type { ContextChip, ContextTarget } from './askContext'
import type { FolderAppearance } from './folderAppearance'
import type { LiveWord } from './liveWords'
import type { Meeting, MeetingCard as StoredMeetingCard, Person, Segment, SnippetPart, Folder } from '../main/store'
import type { CalEvent, CalendarSource, CalendarStatus } from '../main/calendar'
import type { Access, PermissionKind, PermissionStatus } from '../main/permissions'
import type { Capabilities } from './platform'
export type { Access, PermissionKind, PermissionStatus }
/** one first-run question: a permission, or open at login last */
export type OnboardingStep = { kind: PermissionKind; status: Access }
/** the first run: the intro screens (once), then one step per permission still open */
export type OnboardingPlan = { intro: boolean; steps: OnboardingStep[] }
/** a permission still off after the first run, for home's Finish setup */
export type MissingPermission = { kind: PermissionKind; status: Access; essential: boolean }
export type Theme = 'light' | 'dark' | 'system'
/** The capture has stopped, but its final database state may still need an explicit retry. */
export type MeetingView = Meeting & { stopSavePending?: true; paused?: true }
export type MeetingCard = StoredMeetingCard & { paused?: true }

/** What the window sees of the app: window.yogurt (the preload bridge, contextIsolation on) */
export type YogurtApi = {
  platform: NodeJS.Platform
  /** the computer the screens are for: the real one, or in fake mode the one YOGURT_FAKE_PLATFORM pretends to be (shortcut keys follow it) */
  os: string
  /** what this computer can do (shared/platform.ts): Windows and Linux hide the calendar and names from calls */
  capabilities: Capabilities
  /** test mode: stand-ins for models, audio and calendars */
  fake: boolean
  setup: {
    state(): Promise<SetupState>
    /** called with each change; returns the way to stop listening */
    onState(cb: (s: SetupState) => void): () => void
    retry(): Promise<void>
  }
  /** the "Take notes?" and "Stop recording?" card */
  prompt: {
    state(): Promise<PromptView | null>
    act(action: PromptAction): void
  }
  /** the small recording widget */
  widget: {
    state(): Promise<WidgetView | null>
    onState(cb: (v: WidgetView | null) => void): () => void
    /** sound levels 0..1, about 10 a second */
    onLevel(cb: (lv: { me: number; them: number }) => void): () => void
    open(): void
    stop(): void
    layout(): Promise<WidgetLayout | null>
    onLayout(cb: (layout: WidgetLayout) => void): () => void
    onPointer(cb: (point: { x: number; y: number }) => void): () => void
    onReset(cb: () => void): () => void
    surface(rect: WidgetSurface): void
    pressed(value: boolean): void
    /** moves the widget by screen-space deltas during a pointer drag */
    drag(dx: number, dy: number): void
    /** commits the clamped position after the pointer is released or cancelled */
    endDrag(): void
    /** the resting pill size, keeping its right edge fixed */
    size(w: number, h: number): void
  }
  meetings: {
    /** consumes the initial recording reminder once, never on Resume */
    takeRecordingReminder(): Promise<string | null>
    get(id: string): Promise<MeetingView | undefined>
    /** past and current meetings for home, newest first, a page at a time (before: the last card already shown) */
    cards(o: { before?: { at: number; id: string }; limit: number; /** only the meetings in this folder */ folder?: string }): Promise<MeetingCard[]>
    /** starts notes now, for a calendar event (its id) or none, the same way the Take notes card does; opens the note */
    start(eventId: string | null): Promise<StartResult>
    /** opens the note for this occurrence, creating a prepared note if needed; never records */
    prepare(eventId: string, day: number): Promise<StartResult>
    /** records into an existing prepared note, keeping its title, people and typed notes */
    startPrepared(id: string): Promise<StartResult>
    /** adds a new recording session to a finished note without replacing prior audio or transcript */
    resume(id: string): Promise<StartResult>
    /** stops the meeting recording now (the same as the widget's Stop) */
    stop(id: string): void
    /** pauses or resumes this active recording without finishing the note */
    setPaused(id: string, paused: boolean): Promise<boolean>
    /** retries saving the original stop time without stopping or finalizing the capture again */
    retryStopSave(id: string): Promise<boolean>
    /** the person's own title (tidied; blank keeps the old one) */
    rename(id: string, title: string): Promise<void>
    /** gone for good, audio too; refused while it records */
    delete(id: string): Promise<'deleted' | 'recording' | 'save-pending' | 'missing' | 'failed'>
    /** Delete in a list or a note: to the Trash, out of every list, search and chat until restored; refused while it records */
    trash(id: string): Promise<'trashed' | 'recording' | 'save-pending' | 'missing' | 'failed'>
    /** back from the Trash, in its folders as before */
    restore(id: string): Promise<void>
    /** what is in the Trash, the last moved there first (trashedAt set on each) */
    trashed(): Promise<MeetingCard[]>
    /** every meeting in the Trash deleted for good; failed: ones that couldn't go now */
    emptyTrash(): Promise<{ deleted: number; failed: number }>
    /** who was there, set by hand; unedited notes are written again with them */
    renameAttendee(id: string, index: number, name: string, expected: Person): Promise<boolean>
    setAttendees(id: string, people: Person[]): Promise<void>
    /** link: copies this calendar event's title and people; null: unlinks without changing either or rewriting notes */
    linkEvent(id: string, eventId: string | null, day?: number): Promise<void>
    /** called when any meeting starts, stops or changes; returns the way to stop listening */
    onChange(cb: () => void): () => void
  }
  /** the words heard in a meeting, live */
  transcript: {
    /** the meeting's lines; hidden: the echo lines hidden after the meeting too (each marked hidden); last: only the latest lines */
    get(meetingId: string, o?: { hidden?: boolean; last?: number }): Promise<Segment[]>
    /** brings hidden lines back: the ones given, or all of the meeting's */
    restore(meetingId: string, ids?: number[]): Promise<void>
    /** each line as it is saved (a me line a couple of seconds after it was said); returns the way to stop listening */
    onSegment(cb: (s: Omit<Segment, 'id'>) => void): () => void
    /** the meeting's saved lines changed (names from the call after it, echo lines shown again): read them again with get */
    onSpeakers(cb: (meetingId: string) => void): () => void
    /** current unfinished words are replayed on subscribe, then updated live (text empty: the partial is over) */
    onPartial(cb: (p: TranscriptPartial) => void): () => void
  }
  /** the person's own notes and the enhanced notes written after the meeting (Markdown) */
  notes: {
    get(meetingId: string): Promise<NoteView>
    /** saves what the person typed (sent without waiting, so a closing window still gets it out) */
    setMine(meetingId: string, md: string, revision: number): Promise<NoteSaveResult>
    /** saves the person's changes to the enhanced notes */
    setEnhanced(meetingId: string, md: string, revision: number): Promise<NoteSaveResult>
    /** final handoff before a renderer closes/reloads; failed text stays in main for retry */
    flushSync(meetingId: string, side: NoteSide, md: string, revision: number): NoteSaveResult
    /** graceful quit asks the live editor to flush its last debounced edit */
    onFlushRequest(cb: (closing: boolean) => Promise<boolean>): () => void
    /** the open note kept its unsaved edits over notes written again for new people */
    keptEdits(meetingId: string): void
    /** writes the enhanced notes again */
    /** writes the Summary again; with a template, that one becomes the meeting's own first */
    writeAgain(meetingId: string, template?: import('./templates').Template): Promise<void>
    /** status, the draft as it is written, and the saved notes; returns the way to stop listening */
    onChange(cb: (v: NoteView) => void): () => void
  }
  /** copying and exporting a meeting's notes or transcript; `side` is the notes shown (the person's own or the enhanced ones) */
  share: {
    /** puts the notes or the transcript on the clipboard as text and HTML; nothing: there was nothing to copy */
    copy(meetingId: string, what: 'notes' | 'transcript', side: 'mine' | 'enhanced'): Promise<'copied' | 'nothing' | 'failed'>
    /** asks where to save a Markdown file, then writes it */
    save(meetingId: string, side: 'mine' | 'enhanced'): Promise<'saved' | 'cancelled' | 'failed'>
  }
  /** every meeting in one file and back (Settings): import adds the ones that are not here, never changes one that is */
  /** AI apps on this Mac reading meetings through MCP (Settings) */
  mcp: {
    status(): Promise<McpStatus>
    set(on: boolean): Promise<McpStatus>
    onClients(fn: (clients: string[]) => void): () => void
  }
  updates: {
    status(): Promise<UpdateStatus>
    set(on: boolean): Promise<UpdateStatus>
    /** the result arrives through onStatus */
    check(): Promise<void>
    /** quits, installs the downloaded version and reopens; false while recording or with nothing downloaded */
    restart(): Promise<boolean>
    onStatus(fn: (s: UpdateStatus) => void): () => void
  }
  backup: {
    /** import waits while a meeting records */
    status(): Promise<{ recording: boolean }>
    /** asks where to save, then writes the zip */
    export(): Promise<{ ok: true; meetings: number } | { ok: false; error: 'cancelled' | 'failed' } | { ok: false; error: 'unsaved'; meetingId: string }>
    /** asks for a backup, then adds what is new in it */
    import(): Promise<{ ok: true; added: number; skipped: number } | { ok: false; error: 'cancelled' | 'recording' | 'newer' | 'invalid' | 'failed' }>
    /** the file just exported, in Finder */
    show(): void
  }
  /** a meeting's recording, played at yogurt-audio://<meetingId>/<track> */
  audio: {
    /** the tracks there are to play, once the recording is finished (none while it records) */
    tracks(meetingId: string): Promise<Array<'me' | 'them'>>
    /** every microphone, the one chosen (null: Auto) and the one in use; while recording, what the recorder uses */
    mics(): Promise<MicsView>
    /** records with this mic from now on (null: Auto), the meeting being recorded too; remembered for the next one */
    setMic(id: string | null): Promise<boolean>
    /** the mic in use changed while recording; fellBack: the chosen one went away and Auto took over */
    onMics(fn: (e: { fellBack: boolean }) => void): () => void
  }
  /** questions about one meeting, answered by the notes model from its transcript and notes */
  chat: {
    get(meetingId: string): Promise<ChatView>
    /** asks; the answer streams in through onChange */
    ask(meetingId: string, question: string): Promise<void>
    /** stops the answer being written, keeping what is there */
    stop(meetingId: string): void
    /** forgets the meeting's chat */
    clear(meetingId: string): Promise<void>
    onChange(cb: (v: ChatView) => void): () => void
  }
  /** questions across every meeting, in saved conversations (the Chat page) */
  conversations: {
    /** newest first */
    list(): Promise<ConversationSummary[]>
    current(chips: ContextChip[], fresh?: boolean): Promise<string>
    context(id: string, chips: ContextChip[]): Promise<void>
    removeContext(id: string, chip: ContextChip): Promise<void>
    draft(id: string, text: string): Promise<void>
    targets(query: string): Promise<ContextTarget[]>
    get(id: string): Promise<ConversationView | null>
    /** id null starts a new conversation; resolves to its id once the question is saved (null: nothing asked). The answer streams in through onChange */
    ask(id: string | null, question: string): Promise<string | null>
    /** a conversation about one meeting opened: its meeting is read into the model ahead of a question */
    warm(id: string): void
    stop(id: string): void
    rename(id: string, title: string): Promise<void>
    delete(id: string): Promise<void>
    onChange(cb: (v: ConversationView) => void): () => void
    onList(cb: (l: ConversationSummary[]) => void): () => void
  }
  /** the Mac's calendar: what is still to come today and tomorrow */
  calendar: {
    list(): Promise<{ status: CalendarStatus; calendars: (CalendarSource & { enabled: boolean })[] }>
    setEnabled(id: string, enabled: boolean): Promise<boolean>
    onChange(cb: () => void): () => void
    comingUp(): Promise<{ status: CalendarStatus; events: CalEvent[] }>
    /** not asked yet: asks; turned off: opens the Mac's settings */
    connect(): Promise<CalendarStatus>
    /** the events on the day of this time, earliest first (none without Calendar access) */
    day(at: number): Promise<{ status: CalendarStatus; events: AgendaEvent[] }>
  }
  /** what Yogurt may use: read it, ask for it (the Mac's own prompt), or open its pane of System Settings */
  permissions: {
    status(): Promise<PermissionStatus>
    request(kind: PermissionKind): Promise<Access>
    open(kind: PermissionKind): Promise<void>
    /** quit and open Yogurt again, for a permission the Mac applies only then; false while recording */
    relaunch(): Promise<boolean>
  }
  /** first run: the intro and the questions still to ask (none once answered or put off); home's Finish setup after */
  onboarding: {
    plan(): Promise<OnboardingPlan>
    /** the intro was read or skipped: never shown again */
    introSeen(): Promise<void>
    done(): Promise<void>
    /** what home's Finish setup lists now (empty: nothing missing, or put away) */
    nudge(): Promise<MissingPermission[]>
    /** put Finish setup away until something else goes missing */
    dismissNudge(): Promise<void>
    restoreNudge(): Promise<void>
  }
  settings: {
    /** myName: what the person is called in meetings (their Mac's full name, macName, when they never changed it) */
    get(): Promise<{ theme: Theme; openAtLogin: boolean; showInMenuBar: boolean; /** the language picked; '' follows the Mac */ language: string; /** the language in use */ locale: string; /** the Mac's language, among Yogurt's */ systemLocale: string; myName: string; macName: string; /** a recording stops by itself when its call ends (off: ask first) */ stopWhenCallEnds: boolean; recordingReminder: boolean; /** personal jargon, spelled as typed */ jargon: string[]; /** the language people speak in meetings */ spoken: import('./spoken').Spoken; /** the language notes are written in; '' is each meeting's own */ notesLanguage: import('./spoken').NotesLanguage | ''; /** the cloud model, without its key */ cloud: import('./cloud').CloudView; /** how Summaries are written: template, next steps first, the person's own request */ notesStyle: import('./templates').NotesStyle }>
    /** blank goes back to the Mac's full name */
    setName(name: string): Promise<void>
    setTheme(v: Theme): Promise<void>
    setOpenAtLogin(on: boolean): Promise<void>
    setShowInMenuBar(on: boolean): Promise<void>
    setStopWhenCallEnds(on: boolean): Promise<void>
    setRecordingReminder(on: boolean): Promise<void>
    /** saves the whole list; gives back what was kept */
    setJargon(terms: string[]): Promise<string[]>
    /** the interface language ('' follows the Mac); gives back the one now in use */
    setLanguage(id: string): Promise<string>
    /** every window hears the language change, wherever it was picked */
    onLanguage(cb: (locale: string) => void): () => void
    /** English only or Multi-language: the meeting being recorded and the next ones */
    setSpoken(v: import('./spoken').Spoken): Promise<void>
    /** '' for each meeting's own language */
    setNotesLanguage(v: import('./spoken').NotesLanguage | ''): Promise<void>
    /** Settings → Summary: only what changed; answers with how notes are written now */
    setNotesStyle(patch: import('./templates').NotesStylePatch): Promise<import('./templates').NotesStyle | undefined>
    /** turns the cloud model on or off, or changes its address, model or key; answers what is now saved */
    setCloud(v: import('./cloud').CloudPatch): Promise<import('./cloud').CloudView | undefined>
  }
  /** finds meetings by title, transcript and notes; nothing typed: the latest. folder: only the meetings in it */
  search: { query(q: string, folder?: string): Promise<SearchResult[]> }
  /** named folders of meetings; a meeting can be in several, and deleting a folder keeps its meetings */
  folders: {
    suggestion(meetingId: string): Promise<Folder | null>
    dismissSuggestion(meetingId: string): Promise<void>
    list(): Promise<Folder[]>
    /** All folder IDs in sidebar order. Rejects incomplete or stale lists. */
    reorder(ids: string[]): Promise<boolean>
    /** the folders this meeting is in */
    of(meetingId: string): Promise<Folder[]>
    /** undefined for a blank name */
    create(name: string, appearance?: FolderAppearance): Promise<Folder | undefined>
    appearance(id: string, appearance: FolderAppearance): Promise<boolean>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    add(id: string, meetingId: string): Promise<void>
    remove(id: string, meetingId: string): Promise<void>
    onChange(cb: () => void): () => void
  }
  sidebar: {
    /** null while the main window is not ready for workspace actions */
    setOpen(open: boolean | null): void
    onToggle(cb: () => void): () => void
  }
  nav: {
    takeAsk(): Promise<boolean>
    onAsk(cb: () => void): () => void
    /** shows a page in this window: '' for home, /note/<id> */
    go(route: string): void
    /** the page the app was last told to show, e.g. /note/<id>; empty for home */
    current(): Promise<string>
    onGo(cb: (route: string) => void): () => void
  }
}

/** First-run setup: the models this Mac needs. Ready (recording works) once the speech model is in place; the notes models keep downloading after. */
export type SetupState = {
  phase: 'checking' | 'downloading' | 'ready' | 'error'
  /** 0 to 1 over what ready waits for */
  fraction: number
  message?: string
  /** Speech is ready, but the first notes-model download failed. Recording and transcription still work. */
  notesError?: string
  /** The first notes model is still downloading after ready, this far (0 to 1), on every system. */
  notesFraction?: number
  /** Size of the first notes model; ETA is absent until the downloader has an estimate. */
  notesTotalBytes?: number
  notesEtaSec?: number
  /** The first notes model is still downloading after ready, on every system. */
  notesDownloading?: boolean
}

export type { Meeting, Person, Segment, SnippetPart, Folder } from '../main/store'
export type { CalEvent, CalendarSource, CalendarStatus } from '../main/calendar'
/** Calendar occurrence with its saved note, if one exists. No inferred or sample meetings. */
export type AgendaEvent = CalEvent & { note?: { id: string; state: Meeting['state'] } }
/** Start notes: the meeting's id, or why it didn't start (gone: the event left the calendar) */
export type StartResult = { id: string; alreadyRecording?: true } | { error: 'gone' | 'failed' }
/** one meeting found: parts is a piece of its notes or transcript, hit on the words matched */
export type SearchResult = { meetingId: string; title: string; startedAt: number; parts: SnippetPart[] }

/**
 * Where a meeting's enhanced notes are: idle (none yet, the meeting may still be on), waiting (for the transcript or
 * the model), writing (draft streaming in), done (enhanced saved), failed, or empty (nothing was said or typed)
 */
export type NoteStatus = 'idle' | 'waiting' | 'writing' | 'done' | 'failed' | 'empty'
export type NoteSide = 'mine' | 'enhanced'
export type NoteSaveResult = { revision: number; status: 'saved' | 'failed'; retained?: boolean; reason?: 'too-long' }
export type NoteView = {
  meetingId: string; mine: string; enhanced: string | null; edited: boolean; status: NoteStatus; draft: string
  /** a long meeting is read in parts before the notes are written: which one */
  part?: { part: number; of: number }
  /** Windows and Linux: waiting while the notes model loads (it can take a while there) */
  step?: 'loading'
  /** the people at the meeting changed after these edited notes were written, so they may be out of date */
  peopleChanged: boolean
  /** the notes were just written again (for new people): what they replaced, so an open editor with no edits since takes them */
  rewrittenFrom?: string
  /** latest acknowledged edit revision on each side; failed text is retained in main and overlaid above */
  saves?: Partial<Record<NoteSide, NoteSaveResult>>
  /** the template this meeting has of its own (picked for it, or the one its Summary was written with); left out: the one in Settings */
  template?: import('./templates').Template
}

/** The words of a chunk still being spoken, read quickly: shown at once in a lighter style, replaced by the final line */
/**
 * What one side said that is not in a final line yet (one per track, replaced each time; text empty: nothing).
 * words: the same on meeting time, so a final line that arrives can take its own words away at once.
 */
export type TranscriptPartial = { meetingId: string; track: 'me' | 'them'; startMs: number; text: string; words?: LiveWord[] }

/** What the small card at the top right of the screen shows */
export type PromptView =
  | { kind: 'start'; key: string; app: string | null; /** the event's title; empty when there is none */ title: string }
  | { kind: 'stop'; meetingId: string; title: string }
export type PromptAction = 'take-notes' | 'close' | 'stop' | 'keep-going'

/** A microphone on this Mac: its Core Audio UID, its name, and whether the Mac uses it now (Auto records with that one) */
export type MicDevice = { id: string; name: string; isDefault: boolean }
/** The mic picker: the mics, the chosen one (null: Auto), the name in use, and the default's name for Auto */
export type MicsView = { devices: MicDevice[]; choice: string | null; using: string | null; defaultName: string | null }

/** What the recording widget shows: recording (time, hints) or the card after stopping */
export type WidgetView = {
  kind: 'recording' | 'captured'
  paused?: true
  meetingId: string
  title: string
  /** time recorded as of `at` (main's clock); the page counts on from there while recording */
  elapsedMs: number
  at: number
  note: { tone: 'hint' | 'hiccup'; text: string; /** which warning a hint is for */ code?: 'no-mic' | 'no-system-audio'; missingAudio?: ('mic' | 'systemAudio')[] } | null
  /** the recording stopped because the audio helper kept failing */
  crashed: boolean
  /** the recording stopped by itself because the call ended */
  callEnded?: true
}

/** One question about a meeting and its answer: waiting (for the model), answering (streaming), done, stopped (by the person), failed */
export type ChatTurn = { id: number; question: string; answer: string; status: 'waiting' | 'answering' | 'done' | 'stopped' | 'failed' }
export type ChatView = {
  meetingId: string; turns: ChatTurn[]
  /** a Mac with little memory is recording: answers wait for the meeting to end */
  waitsForMeeting: boolean
  /** the first run is still downloading the notes model: answers wait for it */
  waitsForModel: boolean
}

/** [n] in the answer. atMs is the transcript position (null: notes); older saved sources have no excerpt. */
export type LibrarySource = {
  n: number; meetingId: string; title: string; startedAt: number; atMs: number | null; excerpt?: string
  /** Actual chunk segments and the note's stable speaker order; absent on older saved answers. */
  transcript?: { lines: Array<{ text: string; track: 'me' | 'them'; speaker: string | null; startMs: number }>; speakers: string[] }
}

/** One question across meetings and its answer as it is written; sources: what [1], [2]… in the answer point to */
/** what an answer is doing before its first words: the model loading, searching meetings, or reading what it found */
export type AskStep = { kind: 'loading' | 'searching' | 'reading'; title?: string; meetings?: number }
export type ConversationTurn = { id: number; question: string; answer: string; status: ChatTurn['status']; sources: LibrarySource[]; step?: AskStep }
export type ConversationView = {
  id: string; title: string; chips: ContextTarget[]; draft: string; draftChips: ContextTarget[]; firstChips: ContextTarget[] | null; turns: ConversationTurn[]
  /** a Mac with little memory is recording: answers wait for the meeting to end */
  waitsForMeeting: boolean
  /** the first run is still downloading the notes model: answers wait for it */
  waitsForModel: boolean
}
/** a saved conversation in the Chat page's list */
export type ConversationSummary = { id: string; title: string; updatedAt: number; chips: ContextTarget[]; draft: string }

/** enabled: in Settings. clients: apps connected now. command: the program to give an AI app */
export type McpStatus = { enabled: boolean; clients: string[]; command: string }
/** Settings → Updates. available: this build updates itself (not in development or a preview); next: the version found */
export type UpdateStatus = { version: string; available: boolean; on: boolean; state: 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'; next?: string }
