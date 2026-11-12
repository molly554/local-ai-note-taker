import type { Page } from '@playwright/test'

export async function selectNoteVersion(page: Page, side: 'mine' | 'enhanced') {
  await page.getByTestId(side === 'mine' ? 'note-notes-tab' : 'note-summary-tab').click()
}
