import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a full agenda starts at the next event and gives the list priority while details open on demand', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-timeline-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const now = new Date(); now.setHours(12, 0, 0, 0)
    await page.clock.setFixedTime(now)
    const events = Array.from({ length: 24 }, (_, i) => ({ id: `event-${i}`, title: `Meeting ${i}`, calendar: 'Work',
      start: new Date(+now + (i - 12) * 30 * 60_000).toISOString(), end: new Date(+now + ((i - 12) * 30 + 20) * 60_000).toISOString(),
      attendees: [{ name: 'Sam Rivera', email: 'sam@example.com' }],
    }))
    await app.evaluate((_e, events) => (globalThis as any).__fake__.calendarEvents(events), events)
    await page.reload()
    const list = page.getByTestId('agenda-scroll'), detail = page.getByTestId('event-details-content')
    await expect(page.getByTestId('event')).toHaveCount(24)
    await expect(detail).toHaveCount(0)
    const row = (n: number) => page.getByTestId('event').filter({ has: page.getByRole('button', { name: `Meeting ${n}`, exact: true }) })
    await expect.poll(async () => (await row(12).boundingBox())!.y - (await list.boundingBox())!.y).toBeGreaterThanOrEqual(0)
    expect((await row(12).boundingBox())!.y - (await list.boundingBox())!.y).toBeLessThan(24)
    expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await list.evaluate(el => { el.scrollTop = 0 })
    await expect(row(0)).toBeInViewport()
    await row(0).click({ position: { x: 20, y: 8 } })
    await expect(page.getByTestId('home')).toBeVisible()
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toEqual([])
    await expect(detail).toContainText('Meeting 0')
    await expect(detail.getByTestId('event-open')).toHaveText('Prepare note')
    await expect(row(0)).toHaveAttribute('data-selected', 'true')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0)
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('nav-home').click()
    await expect(detail).toHaveCount(0)
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(0)
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(detail).toHaveCount(0)
    await expect.poll(async () => (await row(12).boundingBox())!.y - (await list.boundingBox())!.y).toBeGreaterThanOrEqual(0)
    expect((await row(12).boundingBox())!.y - (await list.boundingBox())!.y).toBeLessThan(24)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 520))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900)
    const listHeight = (await list.boundingBox())!.height
    expect(listHeight).toBeGreaterThan(160)
    const trigger = row(12).getByTestId('event-details')
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(detail.getByRole('heading')).toHaveText('Meeting 12')
    const box = (await detail.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
    expect(Math.abs((await list.boundingBox())!.height - listHeight)).toBeLessThan(1)
    const close = detail.getByRole('button', { name: 'Close', exact: true })
    await expect(close).toBeFocused()
    const closeBox = (await close.boundingBox())!
    expect(closeBox.x).toBeGreaterThanOrEqual(box.x)
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(box.x + box.width)
    expect(closeBox.y).toBeGreaterThanOrEqual(box.y)
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(box.y + box.height)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(Math.abs((await list.boundingBox())!.height - listHeight)).toBeLessThan(1)
    expect(await list.evaluate(el => getComputedStyle(el).maskImage)).not.toBe('none')
  } finally { await app.close() }
})


test('granting calendar access initializes the timeline after events arrive, including after the last event', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_FAKE_CALENDAR: 'notDetermined', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-first-grant-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('calendar-off')).toBeVisible()
    const now = new Date(); now.setHours(22, 0, 0, 0)
    await page.clock.setFixedTime(now)
    const events = Array.from({ length: 18 }, (_, i) => ({ id: `earlier-${i}`, title: `Earlier ${i}`,
      start: new Date(+now - (24-i)*30*60_000).toISOString(), end: new Date(+now - (24-i)*30*60_000 + 20*60_000).toISOString(), attendees: [],
    }))
    await app.evaluate((_e, events) => (globalThis as any).__fake__.calendarEvents(events), events)
    await page.getByTestId('calendar-off').getByRole('button').click()
    await expect(page.getByTestId('event')).toHaveCount(18)
    await expect(page.getByTestId('event').last()).toBeInViewport()
    expect(await page.getByTestId('agenda-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await page.getByTestId('event').last().getByTestId('event-details').click()
    const details = page.getByTestId('event-details-content')
    await expect(details.getByRole('heading')).toHaveText('Earlier 17')
    await expect(details.getByTestId('event-open')).toHaveCount(0)
    await expect(page.getByTestId('event-start')).toHaveCount(0)
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toEqual([])
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(page.getByTestId('event').last().getByTestId('event-details')).toBeFocused()
  } finally { await app.close() }
})
