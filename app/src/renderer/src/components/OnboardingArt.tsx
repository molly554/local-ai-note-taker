import { AudioLines, CalendarDays, Check, Lock, Mic, Plus, X } from 'lucide-react'
import type { PermissionKind } from '../../../shared/types'
import type { ScreenId } from '../../../shared/onboarding'
import { Logo } from './Logo'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'
import macIcon from '../../../../build/icon.png'

/*
 * The first run's pictures, built from the app's own surfaces so they match both themes. Each shows what its screen
 * does, literally: the call written down, the two sides of the sound, the meeting from the calendar, the card when a
 * call starts, Them becoming names. They sit in an aria-hidden stage: the words next to them say the same thing.
 * Motion stops under prefers-reduced-motion, showing the end of each story.
 */

const d = (i: number) => ({ ['--i' as string]: i })

/** W1: the conversation written down and kept on this Mac. */
export function WelcomeArt() {
  return (
    <div className="ob-scene ob-conversation">
      <div className="ob-card">
        <div className="ob-card-head"><AudioLines size={14} strokeWidth={2} />{t('Transcript')}</div>
        <div className="ob-chat">
          <Bubble i={0} who="Ann" text={t('The site goes live on Tuesday.')} />
          <Bubble i={1} me text={t('Great. Who is writing the copy?')} />
          <Bubble i={2} who="Bo" text={t("I'll send a draft by Friday.")} />
        </div>
      </div>
      <span className="ob-chip"><Lock size={11} strokeWidth={2.25} />{osWords({ mac: t('Saved on this Mac'), other: t('Saved on this computer') })}</span>
    </div>
  )
}

/** One line of a call, as the transcript shows it: the other side at the start under their name, yours at the end */
function Bubble({ i, who, text, me }: { i: number; who?: string; text: string; me?: boolean }) {
  return (
    <div className={me ? 'ob-turn ob-turn-me' : 'ob-turn'} style={d(i)}>
      {who && <span className="ob-turn-who">{who}</span>}
      <span className={me ? 'ob-bubble ob-bubble-me' : 'ob-bubble'}>{text}</span>
    </div>
  )
}

/** The picture of one permission screen; on: what is turned on so far */
export function ScreenArt({ id, on }: { id: ScreenId; on: readonly PermissionKind[] }) {
  switch (id) {
    case 'record': return <RecordArt on={on} />
    case 'calendar': return <CalendarArt />
    case 'notifications': return <NoticeArt />
    case 'accessibility': return <SpeakerNamesArt />
  }
}

/** The two things Yogurt hears: you through the mic, everyone else through the Mac's sound. Each comes alive once it is on. */
function RecordArt({ on }: { on: readonly PermissionKind[] }) {
  const lanes = [
    { kind: 'mic' as const, Icon: Mic, who: t('You'), from: t('Microphone') },
    { kind: 'systemAudio' as const, Icon: AudioLines, who: t('Everyone else'), from: t("Your Mac's sound") },
  ]
  return (
    <div data-testid="record-art" className="ob-scene">
      <div className="ob-card ob-record">
        {lanes.map(({ kind, Icon, who, from }, i) => (
          <div key={kind} className="ob-lane" data-on={on.includes(kind)} style={d(i)}>
            <span className="ob-lane-icon"><Icon size={15} strokeWidth={1.9} /></span>
            <span className="ob-lane-copy"><span className="ob-lane-who">{who}</span><span className="ob-lane-from">{from}</span></span>
            <span className="ob-wave">{WAVE.map((h, j) => <i key={j} style={{ ['--h' as string]: h, ['--j' as string]: j + i * 3 }} />)}</span>
            <span className="ob-lane-state"><Check size={11} strokeWidth={3} /></span>
          </div>
        ))}
      </div>
    </div>
  )
}
const WAVE = [.35, .6, .9, .55, .75, 1, .65, .4, .8, .5, .95, .6, .3, .7, .45, .85, .5, .65]

/** A day in the calendar, and the note that already knows the meeting's name and who's in it */
function CalendarArt() {
  const people = ['Ann Lee', 'Bo Park', t('You')]
  return (
    <div className="ob-scene ob-calendar">
      <div className="ob-card ob-day">
        <div className="ob-card-head"><CalendarDays size={12} strokeWidth={2} />{t('Today')}</div>
        <div className="ob-hours">
          {['9:00', '10:00', '11:00', '12:00'].map((h) => <span key={h} className="ob-hour">{h}</span>)}
          <span className="ob-event"><span className="ob-event-title">{t('Design review')}</span><span className="ob-event-time">10:00</span></span>
        </div>
      </div>
      <div className="ob-card ob-meeting-note">
        <p className="ob-note-meta"><CalendarDays size={11} strokeWidth={2} />{t('Today, 10:00')}</p>
        <p className="ob-doc-title">{t('Design review')}</p>
        <ul className="ob-people">{people.map((p, i) => <li key={p} style={d(i)}><span>{p.slice(0, 1)}</span>{p}</li>)}</ul>
        <span className="ob-skeleton" /><span className="ob-skeleton ob-skeleton-short" />
      </div>
    </div>
  )
}

/** The notification alone, with its countdown held while the person reads the first run. */
function NoticeArt() {
  return (
    <div className="ob-scene ob-notice">
        <div className="ob-prompt" data-testid="notice-art">
          <span className="ob-prompt-countdown" />
            <img src={macIcon} alt="" className="ob-prompt-icon" />
            <span className="ob-prompt-copy"><span className="ob-prompt-label">{t('Take notes?')}</span><span className="ob-prompt-title">{t('{app} call', { app: 'Zoom' })}</span></span>
            <span className="ob-prompt-button">{t('Start recording')}</span>
            <X size={13} className="ob-prompt-close" />
        </div>
    </div>
  )
}

/** Why Accessibility: the names the call shows, and the same lines turning from Them into those names */
export function SpeakerNamesArt() {
  const lines: { who?: string; text: string }[] = [
    { who: 'Chris', text: t('Sure. The site goes live on Tuesday.') },
    { text: t('Great. Who is writing the copy?') },
    { who: 'Jenny', text: t("I'll send a draft by Friday.") },
  ]
  return (
    <div data-testid="speaker-names-art" className="ob-scene ob-names">
      <div className="ob-call">
        {['Chris', 'Jenny', t('You')].map((n, i) => <span key={n} className="ob-tile" data-talking={i === 0}><span className="ob-tile-face">{n.slice(0, 1)}</span><span className="ob-tile-name">{n}</span></span>)}
      </div>
      <div className="ob-card ob-chat ob-names-chat">
        {lines.map((l, i) => l.who ? (
          <div key={i} className="ob-turn">
            <span className="ob-turn-who ob-swap" style={d(i)}><span className="ob-swap-from">{t('Them')}</span><span className="ob-swap-to">{l.who}</span></span>
            <span className="ob-bubble">{l.text}</span>
          </div>
        ) : <div key={i} className="ob-turn ob-turn-me"><span className="ob-bubble ob-bubble-me">{l.text}</span></div>)}
      </div>
    </div>
  )
}

/** Where to click in System Settings: its pane with Yogurt in the list, the switch turning on, and + for when it isn't listed */
export function SettingsWindowArt({ pane, section }: { pane: string; section?: string }) {
  return (
    <div data-testid="settings-window-art" className="ob-settings">
      <div className="ob-settings-side">
        <span className="ob-settings-dots"><i /><i /><i /></span>
        {[0, 1, 2, 3, 4, 5].map((k) => <span key={k} className="ob-settings-nav" data-current={k === 4} />)}
      </div>
      <div className="ob-settings-pane">
        <p className="ob-settings-title">{pane}</p>
        {section && <p className="ob-settings-section">{section}</p>}
        <div className="ob-settings-list">
          <div className="ob-settings-row ob-settings-other"><span className="ob-app-icon" /><span className="ob-app-name" /><span className="ob-switch" /></div>
          <div className="ob-settings-row ob-settings-yogurt">
            <span className="ob-app-icon ob-app-yogurt"><Logo size={12} className="text-[#fff]" /></span>
            <span className="ob-settings-app">Yogurt</span>
            <span className="ob-switch ob-switch-on" />
          </div>
          <div className="ob-settings-tools"><Plus size={11} strokeWidth={2.25} /><span className="ob-settings-minus" /></div>
        </div>
      </div>
    </div>
  )
}

export { DownloadBlob as ReadyArt } from './DownloadBlob'
