import { FOLDER_COLORS } from './folderAppearance'

export const SPEAKER_COLORS = Object.keys(FOLDER_COLORS).filter(color => color !== 'default')

/** Append newly named speakers without renumbering names already shown. */
export function speakerOrder(previous: readonly string[], names: readonly (string | null)[]): string[] {
  return [...new Set([...previous, ...names.filter((name): name is string => !!name?.trim())])]
}

export function speakerColor(track: string, name: string | null | undefined, order: readonly string[]): number | undefined {
  const index = track === 'them' && name ? order.indexOf(name) : -1
  return index < 0 ? undefined : index % SPEAKER_COLORS.length
}
