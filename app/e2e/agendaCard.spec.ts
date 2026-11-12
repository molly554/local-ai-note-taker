import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a bottom event opens above its row, tracks scrolling, flips without chatter and dismisses offscreen', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-card-')),
  }, ...(process.env.CI ? { recordVideo: { dir: info.outputPath('agenda-motion'), size: { width: 1100, height: 760 } } } : {}) })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const noon = await page.evaluate(() => { const d = new Date(); d.setHours(12, 0, 0, 0); return +d })
    await page.clock.setFixedTime(noon)
    await app.evaluate((_electron, noon) => {
      const events = Array.from({ length: 24 }, (_, i) => ({
        // Keep noon's live CTA in the day, but use a regular event as the scrolling anchor.
        // A live row is taller, so even near the list top it can correctly retain its top placement.
        id: `day-${i}`, title: i === 13 ? 'Sprint planning' : `Meeting ${i + 1}`,
        start: new Date(noon + (i - 12) * 30 * 60_000).toISOString(),
        end: new Date(noon + (i - 12) * 30 * 60_000 + 25 * 60_000).toISOString(),
        attendees: [{ name: 'Morgan', email: 'morgan@example.com' }], calendarId: 'work', calendar: 'Work',
      }))
      ;(globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void } }).__fake__.calendarEvents(events)
    }, noon)
    await page.reload()
    await expect(page.getByTestId('event')).toHaveCount(24)
    if (await page.getByTestId('sidebar-collapse').count()) await page.getByTestId('sidebar-collapse').click()
    const list = page.getByTestId('agenda-scroll')
    const row = page.getByTestId('event').filter({ hasText: 'Sprint planning' })
    const trigger = row.getByTestId('event-details')
    const card = page.getByTestId('event-details-content')
    const placeRow = async (edge: 'top' | 'bottom') => row.evaluate((el, edge) => {
      const list = el.closest<HTMLElement>('.agenda-scroll')!, r = el.getBoundingClientRect(), bounds = list.getBoundingClientRect()
      // Align the row itself with the list top. A 20px inset leaves only 15px more room
      // below in the CI window, correctly short of the production 24px flip threshold.
      list.scrollTop += edge === 'bottom' ? r.bottom - bounds.bottom + 12 : r.top - bounds.top
    }, edge)
    const geometry = () => card.evaluate(el => {
      const card = el.getBoundingClientRect(), column = el.closest('.native-agenda')!.getBoundingClientRect()
      const row = document.querySelector('.agenda-event[data-selected=true]')!.getBoundingClientRect()
      return {
        left: card.left - column.left, right: column.right - card.right,
        top: card.top, bottom: card.bottom, rowTop: row.top, rowBottom: row.bottom, height: innerHeight,
        roomAbove: Math.max(0, row.top - Math.max(0, column.top) - 20),
        roomBelow: Math.max(0, Math.min(innerHeight, column.bottom) - row.bottom - 20),
      }
    })
    for (const [width, height, colorScheme] of [[1100, 760, 'light'], [720, 520, 'dark']] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(width, height), [width, height])
      await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' })
      await placeRow('bottom')
      await row.hover({ position: { x: 20, y: 8 } })
      const hover = await row.evaluate(el => {
        const time = el.querySelector<HTMLElement>('.agenda-time')!
        const body = el.querySelector<HTMLElement>('.agenda-event-body')!, css = getComputedStyle(el)
        return { background: css.backgroundColor, width: time.getBoundingClientRect().width,
          align: getComputedStyle(time).textAlign, gap: css.columnGap, titleGap: getComputedStyle(body).paddingInlineStart,
          cursor: css.cursor, transition: css.transitionDuration }
      })
      expect(hover.width).toBe(48)
      expect(hover.align).toBe('end')
      expect(hover.gap).toBe('12px')
      expect(hover.titleGap).toBe('12px')
      expect(hover.cursor).toBe('pointer')
      expect(hover.transition).toBe('0s')
      await expect(trigger).toHaveCSS('color', colorScheme === 'light' ? 'rgb(41, 41, 44)' : 'rgb(231, 230, 235)')
      expect(hover.background).not.toBe('rgba(0, 0, 0, 0)')
      // The time and divider hit area opens the same card as the title.
      await row.click({ position: { x: 20, y: 8 } })
      await expect(card).toHaveAttribute('data-side', 'top')
      await expect(card.locator('.agenda-inspector-arrow')).toBeVisible()
      const close = card.getByRole('button', { name: 'Close', exact: true })
      await expect(card.getByRole('heading')).toBeFocused()
      expect(await close.evaluate(el => el.matches(':focus-visible'))).toBe(false)
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      expect(await close.evaluate(el => el.matches(':focus-visible'))).toBe(true)
      const spacing = await card.evaluate(el => {
        const content = el.querySelector('.agenda-inspector-content')!, heading = el.querySelector('h3')!
        const time = el.querySelector('.agenda-inspector-time')!, people = el.querySelector('.agenda-inspector-scroll')!
        const calendar = el.querySelector('.agenda-inspector-footer')!
        return { top: heading.getBoundingClientRect().top - content.getBoundingClientRect().top,
          bottom: content.getBoundingClientRect().bottom - calendar.getBoundingClientRect().bottom,
          titleGap: time.getBoundingClientRect().top - heading.parentElement!.getBoundingClientRect().bottom,
          rowGap: people.getBoundingClientRect().top - time.getBoundingClientRect().bottom }
      })
      expect(spacing).toEqual({ top: 16, bottom: 16, titleGap: 16, rowGap: 16 })
      const initial = await geometry()
      expect(initial.left).toBeCloseTo(8, 0)
      expect(initial.right).toBeCloseTo(8, 0)
      expect(initial.top).toBeGreaterThanOrEqual(8)
      expect(initial.bottom).toBeLessThanOrEqual(initial.rowTop - 11)
      expect(initial.bottom).toBeLessThan(initial.height)
      await list.evaluate(el => { el.scrollTop += 32 })
      await expect.poll(async () => Math.abs((await geometry()).rowTop - initial.rowTop + 32)).toBeLessThan(1)
      await expect.poll(async () => Math.abs((await geometry()).bottom - initial.bottom + 32)).toBeLessThan(1)
      expect(await card.evaluate(el => el.getAnimations().length)).toBe(0)
      await placeRow('top')
      // In a short window the calendar header can leave more room above every visible row.
      const topSide = height > 650 ? 'bottom' : 'top'
      const atTop = await geometry()
      // Assert the fixture's actual room, rather than treating the outer BrowserWindow height
      // as proof of a flip. The bottom side must beat the existing side by more than 24px.
      if (topSide === 'bottom') expect(atTop.roomBelow - atTop.roomAbove).toBeGreaterThan(24)
      else expect(atTop.roomBelow - atTop.roomAbove).toBeLessThanOrEqual(24)
      await expect(card).toHaveAttribute('data-side', topSide)
      if (topSide === 'bottom') await expect.poll(async () => (await geometry()).top - (await geometry()).rowBottom).toBeGreaterThanOrEqual(7)
      // Small scroll reversals around this placement must not restart the side-change motion.
      for (const delta of [3, -5, 4, -2]) {
        await list.evaluate((el, delta) => { el.scrollTop += delta }, delta)
        await expect(card).toHaveAttribute('data-side', topSide)
      }
      await page.keyboard.press('Meta+k')
      await expect(page.getByTestId('search')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('search')).toHaveCount(0)
      await expect(card).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(card).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(close).toBeFocused()
      expect(await close.evaluate(el => el.matches(':focus-visible'))).toBe(true)
      await page.keyboard.press('Escape')
      await placeRow('bottom')
      await trigger.click()
      await card.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await page.getByRole('heading', { name: 'Your meetings', exact: true }).click()
      await expect(card).toHaveCount(0)
      await placeRow('bottom')
      await trigger.click()
      await list.evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect(card).toHaveCount(0)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(1100, 760))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await placeRow('bottom')
    await row.hover({ position: { x: 20, y: 8 } })
    await expect(row).toHaveCSS('transition-duration', '0s')
    await row.click({ position: { x: 20, y: 8 } })
    await expect(card).toHaveAttribute('data-side', 'top')
    await placeRow('top')
    const reducedTop = await geometry()
    expect(reducedTop.roomBelow - reducedTop.roomAbove).toBeGreaterThan(24)
    await expect(card).toHaveAttribute('data-side', 'bottom')
    expect(await card.evaluate(el => el.getAnimations().length)).toBe(0)
    await expect(card).toHaveCSS('transform', 'none')
  } finally { await app.close() }
})

test('long agenda titles stay on one line and forty attendees expand without moving the card footer', async ({}, info) => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-agenda-density-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const title = 'Northwind <> Zentrik — Discovery Call with the extended project team'
    const noon = await page.evaluate(() => { const d = new Date(); d.setHours(12, 0, 0, 0); return +d })
    await page.clock.setFixedTime(noon)
    await app.evaluate((_e, { title, noon }) => {
      ;(globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void } }).__fake__.calendarEvents([{
        id: 'large-call', title, start: new Date(noon + 60_000).toISOString(), end: new Date(noon + 30 * 60_000).toISOString(),
        attendees: Array.from({ length: 40 }, (_, i) => ({ name: `Guest${i + 1} Family`, email: i === 0 ? 'guest1.with.a.very.long.unbroken.address@international.project.example.com' : `guest${i + 1}@example.com` })),
        calendarId: 'work', calendar: 'Work', calendarSource: 'Calendar account', url: 'https://meet.google.com/lar-gec-all',
      }])
    }, { title, noon })
    await page.reload()
    await expect(page.getByTestId('event')).toHaveCount(1)
    const noteId = await page.evaluate(async noon => {
      const day = await window.yogurt.calendar.day(noon)
      const result = await window.yogurt.meetings.prepare(day.events[0].id, noon)
      if (!('id' in result)) throw new Error(result.error)
      return result.id
    }, noon)
    // Preparing a note opens it. Return to the agenda before checking the linked event.
    await expect.poll(() => page.evaluate(() => window.yogurt.nav.current())).toBe(`/note/${noteId}`)
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'prepared')
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home')).toBeVisible()
    await expect(page.getByTestId('event')).toHaveCount(1)
    const trigger = page.getByTestId('event-details')
    await expect(page.locator('.agenda-people')).toHaveText('Guest1, Guest2, Guest3 + 37')
    const card = page.getByTestId('event-details-content')
    for (const [width, height, colorScheme] of [[1100, 760, 'light'], [720, 520, 'dark']] as const) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#'))!.setSize(width, height), [width, height])
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await expect(trigger).toHaveCSS('white-space', 'nowrap')
      await expect(trigger).toHaveCSS('text-overflow', 'ellipsis')
      expect(await trigger.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      await trigger.click()
      await expect(card.getByRole('heading')).toHaveText(title)
      await expect(card.getByRole('list', { name: 'People', exact: true }).getByRole('listitem')).toHaveCount(5)
      await expect(card.getByText('guest1.with.a.very.long.unbroken.address@international.project.example.com', { exact: true })).toHaveCount(0)
      await expect(card.getByRole('listitem').first()).toHaveAttribute('title', 'guest1.with.a.very.long.unbroken.address@international.project.example.com')
      await expect(card.getByTestId('event-open')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`agenda-density-${colorScheme}-${width}-collapsed.png`) })
      await card.getByRole('button', { name: 'and 35 more', exact: true }).click()
      await expect(card.getByRole('listitem')).toHaveCount(40)
      await expect(card.getByText('guest1.with.a.very.long.unbroken.address@international.project.example.com', { exact: true })).toHaveCount(1)
      const body = card.getByTestId('agenda-detail-scroll'), footer = card.getByTestId('agenda-detail-footer')
      const footerTop = await footer.evaluate(el => el.getBoundingClientRect().top)
      const headingTop = await card.getByRole('heading').evaluate(el => el.getBoundingClientRect().top)
      const timeTop = await card.locator('.agenda-inspector-line').first().evaluate(el => el.getBoundingClientRect().top)
      expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await body.evaluate(el => { el.scrollTop = el.scrollHeight })
      expect(await footer.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(footerTop, 0)
      if (process.env.YOGURT_UI_REVIEW !== 'before') {
        expect(await body.evaluate(el => el.clientHeight)).toBeLessThanOrEqual(240)
        expect(await body.evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(79)
        expect(await card.getByRole('heading').evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(headingTop, 0)
        expect(await card.locator('.agenda-inspector-time').evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(timeTop, 0)
        await body.evaluate(el => { el.scrollLeft = 1000 })
        expect(await body.evaluate(el => ({ left: el.scrollLeft, overflow: el.scrollWidth - el.clientWidth }))).toEqual({ left: 0, overflow: 0 })
      }
      await body.evaluate(el => { el.scrollTop = 0 })
      const bounds = await card.evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }))
      expect(bounds.top).toBeGreaterThanOrEqual(8)
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport - 7)
      const footerBounds = await footer.evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
      expect(footerBounds.top).toBeGreaterThanOrEqual(bounds.top)
      expect(footerBounds.bottom).toBeLessThanOrEqual(bounds.bottom)
      await expect(card.getByRole('link', { name: 'Join meeting' })).toBeVisible()
      await expect(card.getByRole('link', { name: 'Join meeting' })).toHaveAttribute('href', 'https://meet.google.com/lar-gec-all')
      await expect(card.getByRole('link', { name: 'Join meeting' })).toHaveClass('workspace-button agenda-open-note')
      await expect(card.getByRole('link', { name: 'Join meeting' })).toHaveCSS('height', '28px')
      await expect(card.locator('.agenda-inspector-actions')).toHaveCSS('justify-content', 'flex-end')
      expect(await card.locator('.agenda-inspector-actions').evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0)
      await expect(card.getByTestId('event-open')).toBeVisible()
      await page.screenshot({ path: info.outputPath(`agenda-density-${colorScheme}-${width}-expanded.png`) })
      await page.keyboard.press('Escape')
      await expect(card).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
  } finally { await app.close() }
})
