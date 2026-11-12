import type { KeyboardEvent } from 'react'
import { Folder, Star, Heart, Flag, Bookmark, BriefcaseBusiness, UsersRound, Handshake, MessageCircle, Video, CalendarDays, Clock, Target, Lightbulb, Rocket, Code, Palette, Megaphone, GraduationCap, BookOpen, FlaskConical, Coffee, House, Plane } from 'lucide-react'
import { FOLDER_ICONS, FOLDER_COLORS, type FolderAppearance, type FolderIconId, type FolderColor } from '../../../shared/folderAppearance'
import { t } from '../../../shared/i18n'

const icons = { folder: Folder, star: Star, heart: Heart, flag: Flag, bookmark: Bookmark, briefcase: BriefcaseBusiness, users: UsersRound,
  handshake: Handshake, message: MessageCircle, video: Video, calendar: CalendarDays, clock: Clock, target: Target, lightbulb: Lightbulb,
  rocket: Rocket, code: Code, palette: Palette, megaphone: Megaphone, graduation: GraduationCap, book: BookOpen, flask: FlaskConical, coffee: Coffee, house: House, plane: Plane }

export function FolderGlyph({ appearance, size = 16 }: { appearance: FolderAppearance; size?: number }) {
  const Icon = icons[appearance.icon] ?? Folder
  return <span className="folder-glyph" data-folder-icon={appearance.icon} data-folder-color={appearance.color} aria-hidden="true"><Icon size={size} strokeWidth={1.75} /></span>
}

function arrowChoice(e: KeyboardEvent<HTMLDivElement>, columns: number) {
  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
  const delta = e.key === 'ArrowDown' ? columns : e.key === 'ArrowUp' ? -columns : e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0
  if (!delta && e.key !== 'Home' && e.key !== 'End') return
  const choices = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  if (!choices.length) return
  e.preventDefault()
  const at = choices.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : (at + delta + choices.length) % choices.length
  choices[next].focus(); choices[next].click()
}

export function FolderChoices({ value, onChange, disabled }: { value: FolderAppearance; onChange: (value: FolderAppearance) => void; disabled: boolean }) {
  return <div className="folder-choices">
    <div className="folder-choice-label">{t('Icon')}</div>
    <div className="folder-icon-grid" role="radiogroup" aria-label={t('Icon')} onKeyDown={(e) => arrowChoice(e, 6)}>
      {(Object.keys(FOLDER_ICONS) as FolderIconId[]).map((icon) => <button key={icon} type="button" role="radio" aria-checked={icon === value.icon}
        data-dialog-focus={icon === value.icon ? true : undefined} aria-label={t(FOLDER_ICONS[icon])} title={t(FOLDER_ICONS[icon])} tabIndex={icon === value.icon ? 0 : -1} disabled={disabled}
        data-testid={`folder-icon-${icon}`} onClick={() => onChange({ ...value, icon })}>
        <FolderGlyph appearance={{ icon, color: value.color }} size={20} />
      </button>)}
    </div>
    <div className="folder-choice-label">{t('Color')}</div>
    <div className="folder-color-grid" role="radiogroup" aria-label={t('Color')} onKeyDown={(e) => arrowChoice(e, 1)}>
      {(Object.keys(FOLDER_COLORS) as FolderColor[]).map((color) => <button key={color} type="button" role="radio" aria-checked={color === value.color}
        aria-label={t(FOLDER_COLORS[color])} title={t(FOLDER_COLORS[color])} tabIndex={color === value.color ? 0 : -1} disabled={disabled}
        data-testid={`folder-color-${color}`} data-folder-color={color} onClick={() => onChange({ ...value, color })}><span /></button>)}
    </div>
  </div>
}
