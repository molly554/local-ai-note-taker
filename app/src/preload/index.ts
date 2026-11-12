import type { WidgetLayout } from '../shared/widgetMorph'
import { contextBridge, ipcRenderer } from 'electron'
import { capabilities, platformOf } from '../shared/platform'
import type { ChatView, ConversationSummary, ConversationView, NoteView, PromptAction, SetupState, UpdateStatus, WidgetView, YogurtApi } from '../shared/types'

const api: YogurtApi = {
  platform: process.platform,
  os: platformOf(process.platform, process.env),
  capabilities: capabilities(platformOf(process.platform, process.env)),
  fake: process.env.YOGURT_FAKE === '1',
  setup: {
    state: () => ipcRenderer.invoke('setup:state'),
    onState: (cb) => {
      const on = (_e: unknown, s: SetupState) => cb(s)
      ipcRenderer.on('setup:state', on)
      return () => { ipcRenderer.removeListener('setup:state', on) }
    },
    retry: () => ipcRenderer.invoke('setup:retry'),
  },
  prompt: {
    state: () => ipcRenderer.invoke('prompt:state'),
    act: (a: PromptAction) => { void ipcRenderer.invoke('prompt:act', a) },
  },
  widget: {
    state: () => ipcRenderer.invoke('widget:state'),
    onState: (cb) => {
      const on = (_e: unknown, v: WidgetView | null) => cb(v)
      ipcRenderer.on('widget:state', on)
      return () => { ipcRenderer.removeListener('widget:state', on) }
    },
    onLevel: (cb) => {
      const on = (_e: unknown, lv: { me: number; them: number }) => cb(lv)
      ipcRenderer.on('widget:level', on)
      return () => { ipcRenderer.removeListener('widget:level', on) }
    },
    open: () => { ipcRenderer.send('widget:open') },
    stop: () => { ipcRenderer.send('widget:stop') },
    layout: () => ipcRenderer.invoke('widget:layout'),
    onLayout: (cb) => {
      const on = (_e: unknown, layout: WidgetLayout) => cb(layout)
      ipcRenderer.on('widget:layout', on)
      return () => { ipcRenderer.removeListener('widget:layout', on) }
    },
    onPointer: (cb) => {
      const on = (_e: unknown, point: { x: number; y: number }) => cb(point)
      ipcRenderer.on('widget:pointer', on)
      return () => { ipcRenderer.removeListener('widget:pointer', on) }
    },
    onReset: (cb) => {
      ipcRenderer.on('widget:reset', cb)
      return () => { ipcRenderer.removeListener('widget:reset', cb) }
    },
    surface: (rect) => { ipcRenderer.send('widget:surface', rect) },
    pressed: (value) => { ipcRenderer.send('widget:pressed', value) },
    drag: (dx, dy) => { ipcRenderer.send('widget:drag', dx, dy) },
    endDrag: () => { ipcRenderer.send('widget:drag-end') },
    size: (w, h) => { ipcRenderer.send('widget:size', w, h) },
  },
  meetings: {
    takeRecordingReminder: () => ipcRenderer.invoke('meetings:take-recording-reminder'),
    get: (id) => ipcRenderer.invoke('meetings:get', id),
    cards: (o) => ipcRenderer.invoke('meetings:cards', o),
    start: (eventId) => ipcRenderer.invoke('meetings:start', eventId),
    prepare: (eventId, day) => ipcRenderer.invoke('meetings:prepare', eventId, day),
    startPrepared: (id) => ipcRenderer.invoke('meetings:start-prepared', id),
    resume: (id) => ipcRenderer.invoke('meetings:resume', id),
    stop: (id) => { ipcRenderer.send('meetings:stop', id) },
    setPaused: (id, paused) => ipcRenderer.invoke('meetings:set-paused', id, paused),
    retryStopSave: (id) => ipcRenderer.invoke('meetings:retry-stop-save', id),
    rename: (id, title) => ipcRenderer.invoke('meetings:rename', id, title),
    delete: (id) => ipcRenderer.invoke('meetings:delete', id),
    trash: (id) => ipcRenderer.invoke('meetings:trash', id),
    restore: (id) => ipcRenderer.invoke('meetings:restore', id),
    trashed: () => ipcRenderer.invoke('meetings:trashed'),
    emptyTrash: () => ipcRenderer.invoke('meetings:empty-trash'),
    renameAttendee: (id, index, name, expected) => ipcRenderer.invoke('meetings:rename-attendee', id, index, name, expected),
    setAttendees: (id, people) => ipcRenderer.invoke('meetings:set-attendees', id, people),
    linkEvent: (id, eventId, day) => ipcRenderer.invoke('meetings:link-event', id, eventId, day),
    onChange: (cb) => {
      const on = () => cb()
      ipcRenderer.on('meetings:changed', on)
      return () => { ipcRenderer.removeListener('meetings:changed', on) }
    },
  },
  transcript: {
    get: (id, o) => ipcRenderer.invoke('transcript:get', id, o),
    restore: (id, ids) => ipcRenderer.invoke('transcript:restore', id, ids),
    onSegment: (cb) => {
      const on = (_e: unknown, seg: Parameters<typeof cb>[0]) => cb(seg)
      ipcRenderer.on('transcript:segment', on)
      return () => { ipcRenderer.removeListener('transcript:segment', on) }
    },
    onSpeakers: (cb) => {
      const on = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('transcript:speakers', on)
      return () => { ipcRenderer.removeListener('transcript:speakers', on) }
    },
    onPartial: (cb) => {
      const on = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p)
      ipcRenderer.on('transcript:partial', on)
      ipcRenderer.send('transcript:subscribe')
      return () => { ipcRenderer.removeListener('transcript:partial', on) }
    },
  },
  notes: {
    get: (id) => ipcRenderer.invoke('notes:get', id),
    setMine: (id, md, revision) => ipcRenderer.invoke('notes:set-mine', id, md, revision),
    setEnhanced: (id, md, revision) => ipcRenderer.invoke('notes:set-enhanced', id, md, revision),
    flushSync: (id, side, md, revision) => ipcRenderer.sendSync('notes:flush-sync', id, side, md, revision),
    onFlushRequest: (cb) => {
      const run = (_e: unknown, token: number | null) => {
        void cb(token !== null).then((saved) => { if (token !== null) ipcRenderer.send('notes:flushed', token, saved) }, () => { if (token !== null) ipcRenderer.send('notes:flushed', token, false) })
      }
      ipcRenderer.on('notes:flush-request', run)
      return () => { ipcRenderer.removeListener('notes:flush-request', run) }
    },
    keptEdits: (id) => { ipcRenderer.send('notes:kept-edits', id) },
    writeAgain: (id) => ipcRenderer.invoke('notes:write-again', id),
    onChange: (cb) => {
      const on = (_e: unknown, v: NoteView) => cb(v)
      ipcRenderer.on('notes:changed', on)
      return () => { ipcRenderer.removeListener('notes:changed', on) }
    },
  },
  share: {
    copy: (id, what, side) => ipcRenderer.invoke('share:copy', id, what, side),
    save: (id, side) => ipcRenderer.invoke('share:save', id, side),
  },
  audio: {
    tracks: (id) => ipcRenderer.invoke('audio:tracks', id),
    mics: () => ipcRenderer.invoke('audio:mics'),
    setMic: (id) => ipcRenderer.invoke('audio:set-mic', id),
    onMics: (fn) => {
      const on = (_e: unknown, v: { fellBack: boolean }) => fn(v)
      ipcRenderer.on('audio:mics-changed', on)
      return () => { ipcRenderer.removeListener('audio:mics-changed', on) }
    },
  },
  chat: {
    get: (id) => ipcRenderer.invoke('chat:get', id),
    ask: (id, q) => ipcRenderer.invoke('chat:ask', id, q),
    stop: (id) => { ipcRenderer.send('chat:stop', id) },
    clear: (id) => ipcRenderer.invoke('chat:clear', id),
    onChange: (cb) => {
      const on = (_e: unknown, v: ChatView) => cb(v)
      ipcRenderer.on('chat:changed', on)
      return () => { ipcRenderer.removeListener('chat:changed', on) }
    },
  },
  conversations: {
    current: (chips, fresh) => ipcRenderer.invoke('conversations:current', chips, fresh),
    context: (id, chips) => ipcRenderer.invoke('conversations:context', id, chips),
    removeContext: (id, chip) => ipcRenderer.invoke('conversations:remove-context', id, chip),
    draft: (id, text) => ipcRenderer.invoke('conversations:draft', id, text),
    targets: (query) => ipcRenderer.invoke('conversations:targets', query),
    list: () => ipcRenderer.invoke('conversations:list'),
    get: (id) => ipcRenderer.invoke('conversations:get', id),
    ask: (id, q) => ipcRenderer.invoke('conversations:ask', id, q),
    stop: (id) => { ipcRenderer.send('conversations:stop', id) },
    warm: (id) => { ipcRenderer.send('conversations:warm', id) },
    rename: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
    delete: (id) => ipcRenderer.invoke('conversations:delete', id),
    onChange: (cb) => {
      const on = (_e: unknown, v: ConversationView) => cb(v)
      ipcRenderer.on('conversations:changed', on)
      return () => { ipcRenderer.removeListener('conversations:changed', on) }
    },
    onList: (cb) => {
      const on = (_e: unknown, l: ConversationSummary[]) => cb(l)
      ipcRenderer.on('conversations:list', on)
      return () => { ipcRenderer.removeListener('conversations:list', on) }
    },
  },
  calendar: {
    list: () => ipcRenderer.invoke('calendar:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('calendar:set-enabled', id, enabled),
    onChange: (cb) => { ipcRenderer.on('calendar:changed', cb); return () => { ipcRenderer.off('calendar:changed', cb) } },
    comingUp: () => ipcRenderer.invoke('calendar:coming-up'),
    connect: () => ipcRenderer.invoke('calendar:connect'),
    day: (at) => ipcRenderer.invoke('calendar:day', at),
  },
  permissions: {
    status: () => ipcRenderer.invoke('permissions:status'),
    request: (k) => ipcRenderer.invoke('permissions:request', k),
    open: (k) => ipcRenderer.invoke('permissions:open', k),
    relaunch: () => ipcRenderer.invoke('permissions:relaunch'),
  },
  onboarding: {
    plan: () => ipcRenderer.invoke('onboarding:plan'),
    introSeen: () => ipcRenderer.invoke('onboarding:intro-seen'),
    done: () => ipcRenderer.invoke('onboarding:done'),
    nudge: () => ipcRenderer.invoke('onboarding:nudge'),
    dismissNudge: () => ipcRenderer.invoke('onboarding:dismiss-nudge'),
    restoreNudge: () => ipcRenderer.invoke('onboarding:restore-nudge'),
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    set: (on) => ipcRenderer.invoke('mcp:set', on),
    onClients: (fn) => { const f = (_e: unknown, c: string[]) => fn(c); ipcRenderer.on('mcp:clients', f); return () => { ipcRenderer.off('mcp:clients', f) } },
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    set: (on) => ipcRenderer.invoke('updates:set', on),
    check: () => ipcRenderer.invoke('updates:check'),
    restart: () => ipcRenderer.invoke('updates:restart'),
    onStatus: (fn) => { const f = (_e: unknown, s: UpdateStatus) => fn(s); ipcRenderer.on('updates:status', f); return () => { ipcRenderer.off('updates:status', f) } },
  },
  backup: {
    status: () => ipcRenderer.invoke('backup:status'),
    export: () => ipcRenderer.invoke('backup:export'),
    import: () => ipcRenderer.invoke('backup:import'),
    show: () => { ipcRenderer.send('backup:show') },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setTheme: (v) => ipcRenderer.invoke('settings:theme', v),
    setShowInMenuBar: (on) => ipcRenderer.invoke('settings:menu-bar', on),
    setOpenAtLogin: (on) => ipcRenderer.invoke('settings:login', on),
    setName: (name) => ipcRenderer.invoke('settings:name', name),
    setStopWhenCallEnds: (on) => ipcRenderer.invoke('settings:auto-stop', on),
    setRecordingReminder: (on) => ipcRenderer.invoke('settings:recording-reminder', on),
    setJargon: (terms) => ipcRenderer.invoke('settings:jargon', terms),
    setLanguage: (id) => ipcRenderer.invoke('settings:language', id),
    onLanguage: (cb) => { const f = (_e: unknown, locale: string) => cb(locale); ipcRenderer.on('settings:language', f); return () => { ipcRenderer.off('settings:language', f) } },
    setSpoken: (v) => ipcRenderer.invoke('settings:spoken', v),
  },
  search: { query: (q, folder) => ipcRenderer.invoke('search:query', q, folder) },
  folders: {
    suggestion: (id) => ipcRenderer.invoke('folders:suggestion', id),
    dismissSuggestion: (id) => ipcRenderer.invoke('folders:dismiss-suggestion', id),
    list: () => ipcRenderer.invoke('folders:list'),
    reorder: (ids) => ipcRenderer.invoke('folders:reorder', ids),
    of: (meetingId) => ipcRenderer.invoke('folders:of', meetingId),
    create: (name, appearance) => ipcRenderer.invoke('folders:create', name, appearance),
    appearance: (id, appearance) => ipcRenderer.invoke('folders:appearance', id, appearance),
    rename: (id, name) => ipcRenderer.invoke('folders:rename', id, name),
    delete: (id) => ipcRenderer.invoke('folders:delete', id),
    add: (id, meetingId) => ipcRenderer.invoke('folders:add', id, meetingId),
    remove: (id, meetingId) => ipcRenderer.invoke('folders:remove', id, meetingId),
    onChange: (cb) => {
      const on = () => cb()
      ipcRenderer.on('folders:changed', on)
      return () => { ipcRenderer.removeListener('folders:changed', on) }
    },
  },
  sidebar: {
    setOpen: (open) => { ipcRenderer.send('sidebar:state', open) },
    onToggle: (cb) => {
      const on = () => cb()
      ipcRenderer.on('sidebar:toggle', on)
      return () => { ipcRenderer.removeListener('sidebar:toggle', on) }
    },
  },
  nav: {
    takeAsk: () => ipcRenderer.invoke('nav:take-ask'),
    onAsk: (cb) => { const fn = () => cb(); ipcRenderer.on('nav:ask', fn); return () => { ipcRenderer.off('nav:ask', fn) } },
    go: (r) => { ipcRenderer.send('nav:go', r) },
    current: () => ipcRenderer.invoke('nav:current'),
    onGo: (cb) => {
      const on = (_e: unknown, r: string) => cb(r)
      ipcRenderer.on('nav:go', on)
      return () => { ipcRenderer.removeListener('nav:go', on) }
    },
  },
}
contextBridge.exposeInMainWorld('yogurt', api)
