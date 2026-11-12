import { msg } from './i18n'

export const FOLDER_ICONS = {
  folder: msg('Folder'), star: msg('Star'), heart: msg('Heart'), flag: msg('Flag'), bookmark: msg('Bookmark'),
  briefcase: msg('Briefcase'), users: msg('People'), handshake: msg('Handshake'), message: msg('Conversation'),
  video: msg('Video'), calendar: msg('Calendar'), clock: msg('Clock'), target: msg('Target'), lightbulb: msg('Idea'),
  rocket: msg('Rocket'), code: msg('Code'), palette: msg('Palette'), megaphone: msg('Megaphone'),
  graduation: msg('Graduation cap'), book: msg('Book'), flask: msg('Flask'), coffee: msg('Coffee'), house: msg('House'), plane: msg('Plane'),
} as const
export const FOLDER_COLORS = {
  default: msg('Default'), violet: msg('Purple'), blue: msg('Blue'), teal: msg('Teal'), green: msg('Green'),
  amber: msg('Amber'), orange: msg('Orange'), rose: msg('Pink'),
} as const
export type FolderIconId = keyof typeof FOLDER_ICONS
export type FolderColor = keyof typeof FOLDER_COLORS
export type FolderAppearance = { icon: FolderIconId; color: FolderColor }
export const DEFAULT_FOLDER_APPEARANCE: FolderAppearance = { icon: 'folder', color: 'default' }
export const isFolderIcon = (v: unknown): v is FolderIconId => typeof v === 'string' && Object.hasOwn(FOLDER_ICONS, v)
export const isFolderColor = (v: unknown): v is FolderColor => typeof v === 'string' && Object.hasOwn(FOLDER_COLORS, v)
export function isFolderAppearance(v: unknown): v is FolderAppearance {
  return !!v && typeof v === 'object' && 'icon' in v && 'color' in v && isFolderIcon(v.icon) && isFolderColor(v.color)
}
