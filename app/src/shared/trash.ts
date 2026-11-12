/** How long a meeting stays in the Trash before it is deleted for good */
export const TRASH_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

/** meetings moved to the Trash before this time are due to go */
export const trashCutoff = (now: number) => now - TRASH_DAYS * DAY
