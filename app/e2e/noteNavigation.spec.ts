import { selectNoteVersion } from './noteVersion'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch() {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_BACKGROUND: '1', YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-note-navigation-')),
  } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('post-call navigation shows Transcript, My notes and Summary without hidden version choices', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    const tabs = page.getByRole('tablist', { name: 'Meeting view' })
    await expect(page.getByRole('tablist')).toHaveCount(1)
    await expect(tabs.getByRole('tab')).toHaveText(['Transcript', 'My notes', 'Summary'])
    const mine = page.getByTestId('note-notes-tab'), summary = page.getByTestId('note-summary-tab')
    await expect(summary).toHaveAttribute('aria-selected', 'true')
    await summary.press('ArrowLeft')
    await expect(mine).toBeFocused()
    await expect(mine).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-mine')).toBeVisible()
    await mine.press('End')
    await expect(summary).toBeFocused()
    await expect(summary).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-enhanced-editor')).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
  } finally { await app.close() }
})

test('primary tabs preserve the editor and its latest text through pause, resume and Finish', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const transcript = page.getByTestId('note-transcript-toggle'), notes = page.getByTestId('note-notes-tab')
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-mine')).toBeVisible()
    await transcript.click()
    await expect(page.getByRole('tabpanel', { name: 'Transcript', exact: true })).toBeVisible()
    await transcript.press('End')
    await expect(notes).toBeFocused()
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    const editor = page.getByTestId('note-mine')
    const exact = 'Keep this exact manual decision through every view change.'
    await editor.fill(exact)
    await editor.evaluate((el) => { (window as unknown as { savedEditor: Element }).savedEditor = el })
    await transcript.click()
    await expect(editor).toBeHidden()
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    await notes.click()
    await expect(editor).toHaveText(exact)
    expect(await editor.evaluate((el) => el === (window as unknown as { savedEditor: Element }).savedEditor)).toBe(true)
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Resume recording')
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    const paused = await page.getByTestId('note-elapsed').innerText()
    await page.waitForTimeout(1100)
    await expect(page.getByTestId('note-elapsed')).toHaveText(paused)
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-pause')).toHaveAccessibleName('Pause recording')
    await expect(notes).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-stop')).toHaveCount(0)
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 30_000 }).toBe('done')
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toBe(exact)
    await expect(notes).toHaveAttribute('data-version', 'enhanced')
    await selectNoteVersion(page, 'mine')
    await expect(editor).toHaveText(exact)
    await expect(page.getByRole('tablist', { name: 'Meeting view', exact: true }).getByRole('tab')).toHaveText(['Transcript', 'My notes', 'Summary'])
  } finally { await app.close() }
})

test('Finish opens and streams Summary; reopening keeps the completed summary', async () => {
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-enhanced')).toHaveAttribute('data-status', 'writing')
    await expect(page.getByTestId('note-enhanced-editor')).toHaveAttribute('aria-readonly', 'true')
    await expect(page.getByTestId('transcript-panel')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 30_000 }).toBe('done')
    await page.reload()
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('note-enhanced')).toBeVisible()
    await expect(page.getByTestId('transcript-panel')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(1)
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('data-version', 'enhanced')
  } finally { await app.close() }
})

test('the underline slides on pointer tab changes without moving the reading panels', async ({}, info) => {
  const { app, page } = await launch()
  try {
    await app.evaluate(() => (globalThis as unknown as { __fake__: { manyMeetings(n: number): void } }).__fake__.manyMeetings(1))
    await page.reload()
    await page.getByTestId('past-note').click()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const transcript = page.getByTestId('note-transcript-toggle'), notes = page.getByTestId('note-notes-tab')
    const pane = page.locator('.note-reading-area [role="tabpanel"]:visible'), bar = page.getByTestId('note-tab-indicator')
    for (const dir of ['ltr', 'rtl']) {
      await page.evaluate(dir => document.documentElement.dir = dir, dir)
      for (const tab of [transcript, notes, page.getByTestId('note-summary-tab')]) {
        await tab.hover()
        if (process.env.YOGURT_UI_REVIEW !== 'before') expect(await tab.locator('svg, svg path').evaluateAll(els => els.every(el => getComputedStyle(el).animationName === 'none'))).toBe(true)
        await tab.click()
        await expect(pane).toHaveCSS('animation-name', 'none')
        await expect(pane).toHaveCSS('transform', 'none')
        await expect(pane).toHaveCSS('opacity', '1')
        expect(await page.locator('.note-panels').evaluate(el => {
          const old = getComputedStyle(el, '::view-transition-old(root)')
          const incoming = getComputedStyle(el, '::view-transition-new(root)')
          return [old.display, old.animationName, incoming.animationDuration, incoming.animationTimingFunction]
        })).toEqual(['none', 'none', '0.12s', 'ease-out'])
        await expect(bar).toHaveCSS('transition-duration', '0.18s, 0.18s')
        await expect.poll(async () => Math.abs((await bar.boundingBox())!.x - (await tab.boundingBox())!.x)).toBeLessThan(1)
        expect(Math.abs((await bar.boundingBox())!.width - (await tab.boundingBox())!.width)).toBeLessThan(1)
      }
    }
    await page.evaluate(() => { document.documentElement.dir = 'ltr' })
    await transcript.click()
    await page.getByTestId('note-summary-tab').click()
    await expect.poll(async () => Math.abs((await bar.boundingBox())!.x - (await page.getByTestId('note-summary-tab').boundingBox())!.x)).toBeLessThan(1)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.getByTestId('note-summary-tab').hover()
      await page.screenshot({ path: info.outputPath(`summary-hover-${colorScheme}.png`) })
    }
    await notes.press('Home')
    await expect(transcript).toBeFocused()
    await expect(bar).toHaveCSS('transition-duration', '0s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await notes.click()
    await expect(bar).toHaveCSS('transition-duration', '0s')
  } finally { await app.close() }
})

for (const reducedMotion of ['reduce', 'no-preference'] as const) for (const from of ['notes', 'transcript'] as const) {
  test(`Finish reveals Summary before switching from ${from}; motion ${reducedMotion}`, async () => {
    const { app, page } = await launch()
    try {
      await page.emulateMedia({ reducedMotion })
      await page.getByRole('button', { name: 'Start recording', exact: true }).click()
      const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
      await page.getByTestId('note-mine').fill('Keep the trial date on Friday.')
      if (from === 'transcript') await page.getByTestId('note-transcript-toggle').click()
      await page.evaluate(from => {
        const samples: { at: number; selected: boolean; previousVisible: boolean }[] = []
        ;(window as unknown as { summaryArrivalSamples: typeof samples }).summaryArrivalSamples = samples
        const observer = new MutationObserver(() => {
          const tab = document.querySelector('#note-summary-tab')
          if (!tab) return
          const selected = tab.getAttribute('aria-selected') === 'true'
          if (samples.length && samples.at(-1)!.selected === selected) return
          samples.push({ at: performance.now(), selected, previousVisible: !document.querySelector<HTMLElement>(`#note-${from === 'notes' ? 'notes' : 'transcript'}-panel`)!.hidden && !selected })
          if (selected) observer.disconnect()
        })
        observer.observe(document.querySelector('[data-testid="note"]')!, { subtree: true, childList: true, attributes: true })
      }, from)
      await page.getByTestId('note-stop').click()
      await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'true')
      const samples = await page.evaluate(() => (window as unknown as { summaryArrivalSamples: { at: number; selected: boolean; previousVisible: boolean }[] }).summaryArrivalSamples)
      if (reducedMotion === 'reduce') {
        expect(samples).toHaveLength(1)
        expect(samples[0]).toMatchObject({ selected: true, previousVisible: false })
      } else {
        expect(samples[0]).toMatchObject({ selected: false, previousVisible: true })
        expect(samples.at(-1)!.at - samples[0].at).toBeGreaterThanOrEqual(100)
      }
      await expect(page.getByTestId('note-summary-tab')).toBeFocused()
      expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).mine).toBe('Keep the trial date on Friday.')
    } finally { await app.close() }
  })
}

test('choosing another tab cancels the pending Finish arrival', async () => {
  const { app, page } = await launch()
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await page.getByTestId('note-transcript-toggle').click()
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('#note-summary-tab')) return
        observer.disconnect()
        document.querySelector<HTMLButtonElement>('#note-notes-tab')!.click()
      })
      observer.observe(document.querySelector('[data-testid="note"]')!, { subtree: true, childList: true })
    })
    await page.getByTestId('note-stop').click()
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await page.waitForTimeout(350)
    await expect(page.getByTestId('note-summary-tab')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('note-mine')).toBeVisible()
  } finally { await app.close() }
})
