/**
 * What a call app's window says about who is in the call and who is talking, read from its accessibility tree
 * (yogurt-mac call-watch copies the tree out; this reads it). Every rule fails towards reading nothing, so a changed
 * app means Them, never a wrong name. The signals each app gives, and how sure we are of them, are in the comments.
 */

/** one element of the tree as the helper copies it: role, subrole, description, title, value, identifier, DOM classes, size */
export type AxNode = { r: string; s?: string; d?: string; t?: string; v?: string; i?: string; c?: string[]; w?: number; h?: number; k?: AxNode[] }
export type AxWindow = { title?: string; id?: string; tree: AxNode }
export type CallKind = 'zoom' | 'teams' | 'meet'
export type CallReading = { speaking: string[]; participants: string[]; me: string | null }

const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.toLocaleLowerCase(), x])).values()]
const walk = (n: AxNode, fn: (n: AxNode, up: AxNode[]) => void, up: AxNode[] = []) => {
  fn(n, up)
  for (const k of n.k ?? []) walk(k, fn, [...up, n])
}
const texts = (n: AxNode) => [n.d, n.t, n.v].filter((x): x is string => !!x)

// ---- Zoom (desktop app, us.zoom.xos) ----
// From Zoom's own strings (Zoom 7.2, its Localizable.strings) and its accessibility tree (Zoom 7.1):
// each video tile is an AXTabGroup described "Name, Computer audio unmuted, Video off", with ", Active speaker"
// at the end on the person talking (Zoom marks someone only with three or more in the call). The participants panel,
// when open, is an AXOutline "Participants list" with rows "Name (me)", "Name (Host)". The small floating window says
// "Talking: Name".

/** Zoom's words, by language: audio on, audio off, the active-speaker mark, the talking label, the participants list, "(me)" */
const ZOOM = [
  ['Computer audio unmuted', 'Computer audio muted', 'Active speaker', 'Talking:', 'Participants list', '(me)'],
  ['Bei Computeraudio Stummschaltung deaktiviert', 'Bei Computeraudio Stummschaltung aktiviert', 'Aktiver Sprecher', 'Sprechen:', 'Teilnehmerliste', '(ich)'],
  ['Audio de la computadora no silenciado', 'Audio de la computadora silenciado', 'Orador activo', 'Hablando:', 'Lista de participantes', '(yo)'],
  ["Son de l'ordinateur rétabli", 'Ordinateur mis en sourdine', 'Intervenant actif', 'La parole est à :', 'Liste des participants', '(moi)'],
  ['Audio computer attivato', 'Audio computer disattivato', 'Oratore attivo', 'Conversazione in corso:', 'Elenco dei partecipanti', '(io)'],
  ['Áudio do computador ativado', 'Áudio do computador desativado', 'Orador ativo', 'Falando:', 'Lista de participantes', '(eu)'],
  ['Computeraudio ingeschakeld', 'Computeraudio gedempt', 'Actieve spreker', 'Aan het spreken:', 'Deelnemerslijst', '(ik)'],
  ['Datorljudet aktiverades', 'Datorljudet inaktiverades', 'Aktiv talare', 'Talar:', 'Deltagarlista', '(jag)'],
  ['ミュート解除されたコンピュータ オーディオ', 'ミュートされたコンピュータ オーディオ', 'アクティブ スピーカー', '発言中:', '参加者リスト', '（自分）'],
  ['电脑音频开启', '电脑音频静音', '当前演讲者', '正在发言：', '参会者列表', '（我）'],
] as const
const low = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim()
const AUDIO = new Set(ZOOM.flatMap((l) => [low(l[0]), low(l[1])]))
const ACTIVE = new Set(ZOOM.map((l) => low(l[2])))
const TALKING = ZOOM.map((l) => l[3].normalize('NFKC').replace(/\s*[:：]$/, ''))
const LISTS = new Set(ZOOM.map((l) => low(l[4])))
const SELF = ZOOM.map((l) => l[5].normalize('NFKC'))
/** other things Zoom appends to a tile, which say nothing about who it is */
const OTHER_STATUS = /^(video (on|off)|no audio|telephone.*|screen sharing.*|pinned|spotlighted)$/i
/** Zoom's own tags after a name: never part of it */
const ZOOM_TAGS = /\s*[(（](me|host|co-host|guest|interpreter|participant id: [^)]*|ich|yo|moi|io|eu|ik|jag|自分|我)[)）]\s*$/i

const cleanZoom = (raw: string): string | null => {
  let name = raw.normalize('NFKC').trim()
  while (ZOOM_TAGS.test(name)) name = name.replace(ZOOM_TAGS, '')
  return name && !/^participants \(/i.test(name) ? name : null
}

/** "Ana Ruiz, Computer audio unmuted, Video off, Active speaker" → Ana Ruiz, talking; null when it isn't a tile */
export function zoomTile(description: string): { name: string; talking: boolean } | null {
  const fields = description.normalize('NFKC').split(/,\s*|、/)
  let talking = false, known = false
  while (fields.length > 1) {
    const f = low(fields.at(-1)!)
    if (ACTIVE.has(f)) talking = known = true
    else if (AUDIO.has(f)) known = true
    else if (!OTHER_STATUS.test(f)) break
    fields.pop()
  }
  if (!known) return null
  const name = cleanZoom(fields.join(', '))
  return name ? { name, talking } : null
}

function readZoom(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const w of windows) {
    walk(w.tree, (n, up) => {
      if (n.r === 'AXTabGroup' && n.d) {
        const tile = zoomTile(n.d)
        if (tile) { participants.push(tile.name); if (tile.talking) speaking.push(tile.name) }
      }
      // the floating window's "Talking: Name"
      if (n.r === 'AXStaticText' && n.v) {
        const v = n.v.normalize('NFKC')
        for (const key of TALKING) if (v.startsWith(key)) { const name = cleanZoom(v.slice(key.length).replace(/^\s*[:：]\s*/, '')); if (name) speaking.push(name) }
      }
      // a row of the participants list: its first text is the name, "(me)" on the person using Yogurt
      if (n.r === 'AXRow' && up.some((a) => a.r === 'AXOutline' && LISTS.has(low(a.d ?? a.t ?? '')))) {
        let text: string | undefined
        walk(n, (x) => { if (!text && x.r === 'AXStaticText' && x.v) text = x.v })
        if (!text) return
        const name = cleanZoom(text)
        if (!name) return
        participants.push(name)
        if (SELF.some((s) => text!.normalize('NFKC').includes(s))) me = name
      }
    })
  }
  return { speaking: uniq(speaking), participants: uniq(participants), me }
}

// ---- Google Meet (in Chrome, Arc, Brave, Edge; Safari and Firefox too where they show the same tree) ----
// Meet marks nobody as talking in words. Each tile shows the person's name as text, and the talking tile gets a CSS
// class, which the browser's tree carries (AXDOMClassList). That class is a build name Google changes between
// releases: as of October 2026 it is "v5h6Xc" (it sits on exactly
// one tile and moves to whoever talks). When it is gone, nobody is marked, and only a call of two can be named.
// A tile is the element seven levels above a name's text, holding just that one name (as measured on Meet's tree).

export const MEET_TALKING_CLASSES = ['v5h6Xc']
const TILE_UP = 7
/** text in Meet's window that is never a person: times, the meeting code, chat */
const NOT_A_NAME = /^\d{1,2}[:.]\d{2}(\s?[AP]M)?$|^[a-z]{3}-[a-z]{4}-[a-z]{3}$|says in chat|^(AM|PM)$|^\d+$/i

function meetName(text: string): string | null {
  const name = text.normalize('NFKC').replace(/\s*\((presenting|presentation|you)[^)]*\)\s*$/i, '').trim()
  return name.length >= 2 && name.length <= 60 && /\p{L}/u.test(name) && !NOT_A_NAME.test(name) ? name : null
}

function readMeet(windows: AxWindow[], o: { talkingClasses?: string[] }): CallReading {
  const marks = new Set(o.talkingClasses ?? MEET_TALKING_CLASSES)
  const groups = new Map<AxNode, string[]>()
  for (const w of windows) {
    if (w.title && !/\bMeet\b/.test(w.title)) continue
    const skip = new Set((w.title ?? '').split(/\s+[-–—]\s+/).map(low))
    walk(w.tree, (n, up) => {
      if (n.r !== 'AXStaticText' || !n.v || up.length < TILE_UP) return
      const name = meetName(n.v)
      if (!name || skip.has(low(name))) return
      const root = up[up.length - TILE_UP]
      groups.set(root, [...(groups.get(root) ?? []), name])
    })
  }
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const [root, names] of groups) {
    const one = uniq(names)
    if (one.length !== 1) continue
    participants.push(one[0])
    // Meet labels the person's own tile "You"
    if (low(one[0]) === 'you') me = one[0]
    let talking = false
    walk(root, (x) => { if (x.c?.some((c) => marks.has(c))) talking = true })
    if (talking) speaking.push(one[0])
  }
  return { speaking: uniq(speaking), participants: uniq(participants), me }
}

// ---- Microsoft Teams (new Teams, com.microsoft.teams2, and classic) ----
// No measured tree to go on: Teams draws its talking ring as a style with no words.
// What is read is words only: an element labelled "Name, speaking" / "Name is speaking" / "Active speaker: Name",
// tiles labelled "Name, muted" / "Name, unmuted" / "Name, video on", and "(You)" after the person's own name in
// the people list. Low confidence until a real call's tree is seen (each recording logs a summary of it).

const TEAMS_SPEAKING = [/^(.{2,60}?)(?:,\s*|\s+is\s+)(?:speaking|talking)\b/i, /\b(?:active speaker|now speaking|speaking now)[:,]?\s+(.{2,60})$/i]
const TEAMS_TILE = /^(.{2,60}?),\s*(?:muted|unmuted|mic(?:rophone)? (?:on|off)|video (?:is )?(?:on|off)|camera (?:is )?(?:on|off))\b/i
const TEAMS_ME = /^(.{2,60}?)\s*\((?:you|me)\)/i
const cleanTeams = (s: string) => s.replace(/\s*\((?:organizer|presenter|guest|external|you|me)\)/gi, '').replace(/[,.:;]+$/, '').trim()

function readTeams(windows: AxWindow[]): CallReading {
  const speaking: string[] = [], participants: string[] = []
  let me: string | null = null
  for (const w of windows) {
    walk(w.tree, (n) => {
      for (const label of texts(n)) {
        for (const re of TEAMS_SPEAKING) { const m = re.exec(label); if (m) { const name = cleanTeams(m[1]); if (name.length >= 2 && !/^(you|me)\b/i.test(name)) speaking.push(name) } }
        const tile = TEAMS_TILE.exec(label)
        if (tile) participants.push(cleanTeams(tile[1]))
        const mine = TEAMS_ME.exec(label)
        if (mine) { me = cleanTeams(mine[1]); participants.push(me) }
      }
    })
  }
  return { speaking: uniq(speaking), participants: uniq(participants.filter((p) => p.length >= 2)), me }
}

/** What the call app shows right now */
export function readCall(kind: CallKind, windows: AxWindow[], o: { talkingClasses?: string[] } = {}): CallReading {
  return kind === 'zoom' ? readZoom(windows) : kind === 'meet' ? readMeet(windows, o) : readTeams(windows)
}

/**
 * A short picture of a window's tree for the log, so a real call shows what its app gives: element counts by role,
 * and the first lines of text with their role (and DOM classes on Meet's tiles). Names stay on the Mac (the log does).
 */
export function summarize(windows: AxWindow[], max = 60): string {
  const roles = new Map<string, number>()
  const lines: string[] = []
  for (const w of windows) {
    lines.push(`window "${(w.title ?? '').slice(0, 60)}"${w.id ? ` id=${w.id}` : ''}`)
    walk(w.tree, (n, up) => {
      roles.set(n.r, (roles.get(n.r) ?? 0) + 1)
      const said = texts(n).map((x) => x.replace(/\s+/g, ' ').slice(0, 80))
      if ((said.length || n.i) && lines.length < max) lines.push(`${'  '.repeat(Math.min(up.length, 12))}${n.r}${n.i ? `#${n.i}` : ''} ${said.map((x) => JSON.stringify(x)).join(' ')}${n.c?.length ? ` .${n.c.slice(0, 6).join('.')}` : ''}`)
    })
  }
  return [`roles: ${[...roles].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ')}`, ...lines].join('\n')
}
