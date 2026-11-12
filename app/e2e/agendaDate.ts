import type { Page } from '@playwright/test'

/** Select tomorrow or the following day, including when it falls in the next week. */
export async function selectUpcomingAgendaDay(page: Page, offset: 1 | 2) {
  const label = await page.evaluate((days) => {
    const date = new Date(); date.setDate(date.getDate() + days)
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }, offset)
  const agenda = page.getByRole('complementary', { name: 'Agenda' })
  const day = agenda.getByRole('button', { name: label, exact: true })
  if (!await day.count()) {
    const direction = await agenda.locator('[aria-current=date]').count() ? 'Next week' : 'Previous week'
    await agenda.getByRole('button', { name: direction, exact: true }).click()
  }
  await day.click()
}
