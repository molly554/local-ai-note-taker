import { LoadingContent } from '../components/LoadingContent'
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, Copy, Download, ExternalLink, Globe, Lock, Upload } from 'lucide-react'
import type { Access, McpStatus, PermissionKind, PermissionStatus, Theme, UpdateStatus } from '../../../shared/types'
import { permissionCopy } from '../permissionCopy'
import { LOCALES, t } from '../../../shared/i18n'
import { osWords } from '../keys'
import { applyLanguage } from '../i18n'
import { flushOpenNotes } from '../noteAutosave'
import { Jargon } from '../components/Jargon'
import { SpokenSetting } from '../components/SpokenSetting'
import { useScrollMemory } from '../useScrollMemory'
import { appShortcuts } from '../components/Shortcuts'
import { CalendarSettings } from '../components/CalendarSettings'
import { supportedKinds } from '../../../shared/platform'
import { Swap, SwapText } from '../components/Swap'

const THEMES = () => [['system', osWords({ mac: t('Match my Mac'), windows: t('Match Windows'), linux: t('Match my system') })], ['light', t('Light')], ['dark', t('Dark')]] as const
// each computer's own words for starting at login and its icon's place: the menu bar, the notification area, the tray
const loginLabel = () => osWords({ mac: t('Open Yogurt when your Mac starts'), windows: t('Open Yogurt when Windows starts'), linux: t('Open Yogurt when you log in') })
const trayLabel = () => osWords({ mac: t('Show Yogurt in the menu bar'), windows: t('Show Yogurt in the notification area'), linux: t('Show Yogurt in the tray') })

/** Settings, kept small: what Yogurt may use, your name, open at login, stop when the call ends, light or dark, a backup and updates. Nothing technical. */
export function Settings({ revision = 0 }: { revision?: number }) {
  const [perms, setPerms] = useState<PermissionStatus>()
  const [prefs, setPrefs] = useState<{ theme: Theme; openAtLogin: boolean; showInMenuBar: boolean; myName: string; macName: string; stopWhenCallEnds: boolean; recordingReminder: boolean }>()
  const [name, setName] = useState('')
  const scroll = useScrollMemory<HTMLDivElement>('settings', !!prefs && !!perms)
  useEffect(() => { void window.yogurt.settings.get().then(setPrefs) }, [revision])
  const reload = useCallback(() => { void window.yogurt.permissions.status().then(setPerms) }, [])
  useEffect(() => {
    reload()
    void window.yogurt.settings.get().then((p) => { setPrefs(p); setName(p.myName) })
    // back from System Settings: show what changed there
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  const theme = (v: Theme) => { setPrefs((p) => p && { ...p, theme: v }); void window.yogurt.settings.setTheme(v) }
  /** saved when they leave the field or press Return; blank goes back to the Mac's name */
  const saveName = () => {
    if (!prefs) return
    const clean = name.replace(/\s+/g, ' ').trim()
    const next = clean || prefs.macName
    setName(next); setPrefs({ ...prefs, myName: next })
    void window.yogurt.settings.setName(clean)
  }
  const login = () => {
    if (!prefs) return
    const on = !prefs.openAtLogin
    setPrefs({ ...prefs, openAtLogin: on }); void window.yogurt.settings.setOpenAtLogin(on)
  }
  const autoStop = () => {
    if (!prefs) return
    const on = !prefs.stopWhenCallEnds
    setPrefs({ ...prefs, stopWhenCallEnds: on }); void window.yogurt.settings.setStopWhenCallEnds(on)
  }

  return (
    <div data-testid="settings" className="settings-screen">
      <div className="settings-titlebar-space" />
      <div className="settings-scroll" ref={scroll}>
        <div className="settings-content">
          <h1 data-testid="settings-heading" className="settings-heading">{t('Settings')}</h1>
          <p className="settings-intro">{osWords({ mac: t('Make Yogurt feel at home on your Mac.'), other: t('Make Yogurt feel at home on your computer.') })}</p>

          <h2 className="settings-section-heading">{t('General')}</h2>
          <div className="settings-group"><LoadingContent pending={!prefs} testId="settings-loading">
            <div className="settings-row">
              <label htmlFor="settings-theme" className="settings-label settings-row-copy">{t('Appearance')}</label>
              <span className="settings-select-wrap">
                <select id="settings-theme" data-testid="settings-theme" value={prefs?.theme ?? 'system'} disabled={!prefs}
                  onChange={(e) => theme(e.target.value as Theme)} className="settings-select">
                  {THEMES().map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor="settings-name" className="settings-label">{t('Your name')}</label>
                <p className="settings-description">{t('So Yogurt knows which name in your calls is you.')}</p>
              </div>
              <input id="settings-name" data-testid="settings-name" value={name} maxLength={80} autoComplete="name" spellCheck={false}
                onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="settings-name-field" />
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{loginLabel()}</p>
                <p className="settings-description">{t('It runs in the background, ready for your first call.')}</p>
              </div>
              <button data-testid="login-toggle" role="switch" aria-checked={!!prefs?.openAtLogin} aria-label={loginLabel()} onClick={login}
                className="settings-toggle">
                <span className="settings-toggle-knob" />
              </button>
            </div>
            <div className="settings-row">
              <p className="settings-label settings-row-copy">{trayLabel()}</p>
              <button data-testid="menu-bar-toggle" role="switch" aria-checked={!!prefs?.showInMenuBar} aria-label={trayLabel()}
                onClick={() => { if (!prefs) return; const on = !prefs.showInMenuBar; setPrefs({ ...prefs, showInMenuBar: on }); void window.yogurt.settings.setShowInMenuBar(on) }}
                className="settings-toggle"><span className="settings-toggle-knob" /></button>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{t('Finish recording when the call ends')}</p>
                <p className="settings-description">{t('Automatically end the recording a few seconds after you hang up.')}</p>
              </div>
              <button data-testid="autostop-toggle" role="switch" aria-checked={!!prefs?.stopWhenCallEnds} aria-label={t('Finish recording when the call ends')} onClick={autoStop}
                className="settings-toggle">
                <span className="settings-toggle-knob" />
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{t('Recording reminder')}</p>
                <p className="settings-description">{t('Show a brief reminder when recording starts.')}</p>
              </div>
              <button data-testid="recording-reminder-toggle" role="switch" aria-checked={!!prefs?.recordingReminder} aria-label={t('Recording reminder')}
                onClick={() => { if (!prefs) return; const on = !prefs.recordingReminder; setPrefs({ ...prefs, recordingReminder: on }); void window.yogurt.settings.setRecordingReminder(on) }}
                className="settings-toggle"><span className="settings-toggle-knob" /></button>
            </div>
          </LoadingContent></div>

          <h2 className="settings-section-heading">{t('What Yogurt can use')}</h2>
          <LoadingContent pending={!perms}><ul className="settings-group">
            {supportedKinds(window.yogurt.capabilities).map((k) => <PermissionRow key={k} kind={k} status={perms?.[k]} onAsk={() => void window.yogurt.permissions.request(k).then(reload)} />)}
          </ul></LoadingContent>

          {window.yogurt.capabilities.calendar && <CalendarSettings />}

          <h2 className="settings-section-heading">{t('Language')}</h2>
          <div data-testid="settings-language" className="settings-group">
            <AppLanguage />
            <SpokenSetting />
            <Jargon />
          </div>

          <Backup />

          <AiApps />

          <Updates />

          <h2 className="settings-section-heading">{t('Keyboard shortcuts')}</h2>
          <dl data-testid="settings-shortcuts" className="settings-group settings-shortcuts">
            {appShortcuts().map(([label, keys]) =>
              <div className="settings-row" key={keys}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}
          </dl>

          <p className="settings-privacy"><Lock size={12} aria-hidden="true" />{osWords({ mac: t('Your meetings, notes and audio stay on this Mac.'), other: t('Your meetings, notes and audio stay on this computer.') })}</p>
        </div>
      </div>
    </div>
  )
}

/** Settings → Language: the interface's language, the Mac's unless one is picked. It changes at once, in every window */
function AppLanguage() {
  const [s, setS] = useState<{ language: string; systemLocale: string }>()
  useEffect(() => { void window.yogurt.settings.get().then(setS) }, [])
  const pick = (language: string) => {
    setS((p) => p && { ...p, language })
    void window.yogurt.settings.setLanguage(language).then(applyLanguage)
  }
  const system = LOCALES.find((l) => l.id === s?.systemLocale)?.name ?? 'English'
  return (
    <LoadingContent pending={!s} testId="language-loading"><div className="settings-row">
      <span className="settings-permission-icon"><Globe size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-app-language" className="settings-label">{t('App language')}</label>
        <p className="settings-description">{t("Yogurt's menus and buttons. Notes are written in the language of each meeting.")}</p>
      </div>
      <span className="settings-select-wrap">
      <select id="settings-app-language" data-testid="settings-app-language" value={s?.language ?? ''} disabled={!s} onChange={(e) => pick(e.target.value)} className="settings-select">
        <option value="">{t('System language ({name})', { name: system })}</option>
        {/* each in its own name, so anyone can find theirs */}
        {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.name}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}

export function PermissionRow({ kind, status, onAsk }: { kind: PermissionKind; status?: Access; onAsk(): void }) {
  const c = permissionCopy(kind)
  const Icon = c.icon
  const ask = status === 'unknown' && kind !== 'accessibility'
  const turnOn = ask || status === 'denied' && kind !== 'accessibility' && kind !== 'notifications'
  const granted = status === 'granted'
  return (
    <li data-testid="permission-row" data-kind={kind} data-status={status ?? ''} className="settings-row">
      <span className="settings-permission-icon"><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <p className="settings-permission-label">
          {c.name}
          {status && !(status === 'unknown' && turnOn) && <span data-testid="permission-status" className="settings-permission-status">
            {status === 'granted' ? t('On') : status === 'denied' ? t('Off') : status === 'unknown' ? t('Not set up')
              : status === 'asked' ? t('Check in Settings') : t('Managed by your organization')}
          </span>}
        </p>
        <p className="settings-description">{c.reason}</p>
      </div>
      {status !== 'restricted' ? (
        <button data-testid={ask ? 'permission-ask' : 'permission-open'} onClick={ask ? onAsk : () => void window.yogurt.permissions.open(kind)}
          className={`workspace-button settings-action${granted ? '' : ' primary'}`}>
          <span>{!status || granted ? t('Manage') : turnOn ? t('Turn on') : osWords({ mac: t('Open System Settings'), other: t('Open Settings') })}</span>
          {!ask && <ExternalLink size={13} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />}
        </button>
      ) : null}
    </li>
  )
}

type Said = { kind: 'exported'; count: number } | { kind: 'imported'; added: number; skipped: number } | { kind: 'error'; text: string; meetingId?: string }

/** every meeting to one file, and back: for a new Mac or after reinstalling */
function Backup() {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [said, setSaid] = useState<Said | null>(null)
  useEffect(() => {
    const check = () => void window.yogurt.backup.status().then((s) => setRecording(s.recording))
    check()
    return window.yogurt.meetings.onChange(check)
  }, [])
  const exportAll = async () => {
    setBusy('export'); setSaid(null)
    // A failed navigation handoff may still be retained by the renderer rather than main.
    if (!await flushOpenNotes().catch(() => false)) {
      setBusy(null); setSaid({ kind: 'error', text: t("Couldn't save your latest changes. Return to your note and try again.") }); return
    }
    const r = await window.yogurt.backup.export().catch(() => ({ ok: false, error: 'failed' } as const)).finally(() => setBusy(null))
    if (r.ok) setSaid({ kind: 'exported', count: r.meetings })
    else if (r.error === 'failed') setSaid({ kind: 'error', text: t("Couldn't save the backup. Try again, or pick another place.") })
    else if (r.error === 'unsaved') setSaid({ kind: 'error', text: t("Save your latest note changes before exporting a backup."), meetingId: r.meetingId })
  }
  const importAll = async () => {
    setBusy('import'); setSaid(null)
    const r = await window.yogurt.backup.import().catch(() => ({ ok: false, error: 'failed' } as const)).finally(() => setBusy(null))
    if (r.ok) { setSaid({ kind: 'imported', added: r.added, skipped: r.skipped }); return }
    const text = {
      cancelled: '', recording: t('You can import once the recording stops.'),
      newer: t('This backup is from a newer Yogurt. Update Yogurt, then try again.'),
      invalid: t("That file isn't a Yogurt backup."),
      failed: t("Couldn't import that backup. Try again."),
    }[r.error]
    if (text) setSaid({ kind: 'error', text })
  }
  const pill = 'workspace-button'
  return (
    <>
      <h2 className="settings-section-heading">{t('Backup')}</h2>
      <div data-testid="backup" className="settings-group settings-backup">
        <p className="settings-description">{osWords({ mac: t('Save every meeting, its notes, transcript and recording to one file. Use it to move to a new Mac or after reinstalling.'), other: t('Save every meeting, its notes, transcript and recording to one file. Use it to move to a new computer or after reinstalling.') })}</p>
        <div className="settings-backup-actions">
          <button data-testid="backup-export" disabled={!!busy} onClick={() => void exportAll()} className={pill}>
            <Download size={14} aria-hidden="true" className="text-muted" />{busy === 'export' ? t('Exporting…') : t('Export all notes')}
          </button>
          <button data-testid="backup-import" disabled={!!busy || recording} onClick={() => void importAll()} className={pill}>
            <Upload size={14} aria-hidden="true" className="text-muted" />{busy === 'import' ? t('Importing…') : t('Import notes')}
          </button>
          {recording && <span data-testid="backup-wait" className="settings-description">{t('You can import once the recording stops.')}</span>}
        </div>
        <div aria-live="polite">
          {said && (
            <p data-testid="backup-said" data-kind={said.kind} className={`settings-backup-status ${said.kind === 'error' ? 'text-danger' : 'text-ink'}`}>
              {said.kind === 'exported' && <>
                <span className="flex items-center gap-1.5"><Check size={14} aria-hidden="true" className="text-muted" />{t('Exported {count} meetings', { count: said.count })}</span>
                <button data-testid="backup-show" onClick={() => window.yogurt.backup.show()} className="settings-link">{osWords({ mac: t('Show in Finder'), windows: t('Show in File Explorer'), linux: t('Show in Files') })}</button>
              </>}
              {said.kind === 'imported' && <span className="flex items-center gap-1.5"><Check size={14} aria-hidden="true" className="text-muted" />
                {said.added ? t('Added {count} meetings.', { count: said.added }) : t('Nothing new in this backup.')}
                {said.skipped > 0 && ' ' + t('{count} were already here.', { count: said.skipped })}</span>}
              {said.kind === 'error' && <>{said.text}{said.meetingId && <button data-testid="backup-open-note" className="settings-link" onClick={() => window.yogurt.nav.go(`/note/${said.meetingId}`)}>{t('Open note')}</button>}</>}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

/** AI apps on this Mac reading meetings through MCP: off until turned on, with what that means */
function AiApps() {
  const [status, setStatus] = useState<McpStatus>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.yogurt.mcp.status().then(setStatus)
    return window.yogurt.mcp.onClients((clients) => setStatus((s) => s && { ...s, clients }))
  }, [])
  const toggle = () => { if (status) { setStatus({ ...status, enabled: !status.enabled }); void window.yogurt.mcp.set(!status.enabled).then(setStatus) } }
  const copy = () => { if (status) void navigator.clipboard.writeText(status.command).then(() => setCopied(true)) }
  const on = !!status?.enabled
  return (
    <>
      <h2 className="settings-section-heading">{t('AI apps')}</h2>
      <LoadingContent pending={!status} testId="ai-apps-loading"><div data-testid="ai-apps" className="settings-group">
        <div className="settings-row">
          <div className="settings-row-copy">
            <p className="settings-label">{t('Let AI apps read your meetings')}</p>
            <p className="settings-description">{osWords({ mac: t('Apps on this Mac can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.'), other: t('Apps on this computer can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.') })}</p>
          </div>
          <button data-testid="ai-apps-toggle" role="switch" aria-checked={on} aria-label={t('Let AI apps read your meetings')} onClick={toggle} className="settings-toggle">
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {on && status &&
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-description">{t('Copy this command and add it as a local MCP server in your AI app.')}</p>
              <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-line bg-bg p-1.5">
                <input data-testid="ai-apps-command" aria-label={t('MCP command')} dir="ltr" readOnly value={status.command} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-muted" />
                <button data-testid="ai-apps-copy" onClick={copy} className="workspace-button shrink-0">
                  <Swap show={copied ? 'done' : 'copy'} options={{ copy: <Copy size={14} className="text-muted" />, done: <Check size={14} className="text-muted" /> }} /><SwapText text={copied ? t('Copied') : t('Copy')} widest={t('Copied')} />
                </button>
              </div>
              {status.clients.length > 0 && <p data-testid="ai-apps-clients" aria-live="polite" className="mt-3 text-[12px] leading-[18px] text-muted">
                {t('Connected now: {apps}', { apps: [...new Set(status.clients)].join(', ') })}
              </p>}
            </div>
          </div>
        }
      </div></LoadingContent>
    </>
  )
}

/** the version, and in a build that updates itself: the switch, what it's doing, Check now, and Restart Yogurt once a new version is ready */
function Updates() {
  const [status, setStatus] = useState<UpdateStatus>()
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    void window.yogurt.updates.status().then(setStatus)
    return window.yogurt.updates.onStatus(setStatus)
  }, [])
  const toggle = () => { if (status) { setStatus({ ...status, on: !status.on }); void window.yogurt.updates.set(!status.on).then(setStatus) } }
  const restart = () => void window.yogurt.updates.restart().then((ok) => setBlocked(!ok))
  const said = status?.available ? {
    idle: '', latest: t('Up to date'), checking: t('Checking for updates…'), error: t("Couldn't check for updates."),
    downloading: t('Downloading version {version}…', { version: status.next ?? '' }), ready: t('Yogurt {version} is ready', { version: status.next ?? '' }),
  }[status.state] : ''
  return (
    <>
      <h2 className="settings-section-heading">{t('Updates')}</h2>
      <LoadingContent pending={!status} testId="updates-loading"><div data-testid="updates" className="settings-group">
        {status?.available &&
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{t('Update Yogurt automatically')}</p>
              <p className="settings-description">{t('New versions download in the background and install when you quit.')}</p>
            </div>
            <button data-testid="updates-toggle" role="switch" aria-checked={status.on} aria-label={t('Update Yogurt automatically')} onClick={toggle} className="settings-toggle">
              <span className="settings-toggle-knob" />
            </button>
          </div>}
        <div className="settings-row">
          <div className="settings-row-copy" aria-live="polite">
            <p data-testid="updates-version" className="settings-label">{t('Version {version}', { version: status?.version ?? '' })}</p>
            {said && <p data-testid="updates-state" data-state={status?.state} className="settings-description">{said}</p>}
            {blocked && <p className="settings-description">{t('You can restart once the recording stops.')}</p>}
          </div>
          {status?.state === 'ready' &&
            <button data-testid="updates-restart" onClick={restart} className="workspace-button settings-action primary">{t('Restart Yogurt')}</button>}
          {status?.available && status.on && (status.state === 'idle' || status.state === 'latest' || status.state === 'error') &&
            <button data-testid="updates-check" onClick={() => void window.yogurt.updates.check()} className="workspace-button settings-action">{status.state === 'error' ? t('Try again') : t('Check now')}</button>}
        </div>
      </div></LoadingContent>
    </>
  )
}
