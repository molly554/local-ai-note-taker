import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const theme of ['light', 'dark'] as const) test(`note panels fade in alone without moving or losing edits in ${theme}`, async ({}, info) => {
  const before = process.env.YOGURT_UI_REVIEW === 'before'
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_BACKGROUND: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-note-fade-')),
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.setContentSize(1200, 850))
    const id = await app.evaluate(async () => (await (globalThis as unknown as { __fake__: { chatMeetings(): Promise<string[]> } }).__fake__.chatMeetings())[0])
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const transcript = page.getByTestId('note-transcript-toggle'), mine = page.getByTestId('note-notes-tab'), summary = page.getByTestId('note-summary-tab')
    await mine.click()
    const editor = page.getByTestId('note-mine')
    const words = 'Send Tarun the quote for fifty seats. Check whether the December start date works for finance.'
    await editor.fill(words)
    await transcript.click()
    await expect(page.getByTestId('transcript')).toContainText('How much would fifty seats be?')
    await expect(page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    if (!before) {
      // Freeze snapshots at known times for repeatable captures, without altering shipped timing.
      await page.evaluate(() => {
        const root = document.querySelector('.note-panels') as HTMLElement & { startViewTransition: (update: () => void) => ViewTransition }
        const start = root.startViewTransition.bind(root)
        root.startViewTransition = update => {
          const transition = start(update)
          ;(window as unknown as { tabTransition: ViewTransition }).tabTransition = transition
          void transition.ready.then(() => {
            root.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation && a.animationName.startsWith('note-panel-')).forEach(a => { a.pause(); a.currentTime = 0 })
          }).catch(() => {})
          return transition
        }
      })
    }
    for (const [label, tab] of [['my-notes', mine], ['summary', summary], ['transcript', transcript]] as const) {
      await page.screenshot({ path: info.outputPath(`tabs-${before ? 'before' : 'after'}-${theme}-${label}-start.png`) })
      const header = await page.locator('.note-header').boundingBox()
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      if (!before) {
        await page.evaluate(() => (window as unknown as { tabTransition: ViewTransition }).tabTransition.ready)
        const animation = await page.locator('.note-panels').evaluate(root => root.getAnimations({ subtree: true })
          .filter(a => a instanceof CSSAnimation && a.animationName.startsWith('note-panel-'))
          .map(a => ({ duration: a.effect!.getTiming().duration, frames: (a.effect as KeyframeEffect).getKeyframes() })))
        expect(animation).toHaveLength(1)
        expect(await page.locator('.note-panels').evaluate(root => {
          const old = getComputedStyle(root, '::view-transition-old(root)')
          return [old.display, old.animationName]
        })).toEqual(['none', 'none'])
        for (const a of animation) {
          expect(a.duration).toBe(120)
          expect(a.frames.every(f => !f.transform && !f.scale && !f.translate && !f.filter)).toBe(true)
        }
      }
      for (const ms of [0, 30, 60, 90, 120]) {
        if (!before) await page.locator('.note-panels').evaluate((root, ms) => {
          root.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation && a.animationName.startsWith('note-panel-')).forEach(a => { a.currentTime = ms })
        }, ms)
        await page.screenshot({ path: info.outputPath(`tabs-${before ? 'before' : 'after'}-${theme}-${label}-${ms}.png`) })
      }
      expect(await page.locator('.note-header').boundingBox()).toEqual(header)
      if (!before) await page.evaluate(async () => {
        const transition = (window as unknown as { tabTransition: ViewTransition }).tabTransition
        transition.skipTransition()
        await transition.finished
      })
    }
    if (before) return
    // Rapid requests must finish on the last tab, including a click back before a snapshot commits.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#note-notes-tab')!.click()
      document.querySelector<HTMLButtonElement>('#note-transcript-tab')!.click()
    })
    await expect(transcript).toHaveAttribute('aria-selected', 'true')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mine.click()
    await expect(editor).toHaveText(words)
    if (!before) await expect.poll(() => page.locator('.note-panels').evaluate(root => root.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation && a.animationName.startsWith('note-panel-')).length)).toBe(0)
    expect((await page.evaluate(id => window.yogurt.notes.get(id), id)).mine).toBe(words)
    await page.getByTestId('chat-open').click()
    await page.getByTestId('chat-input').fill('Keep this question while switching tabs')
    await transcript.click()
    await expect(page.getByTestId('chat-input')).toHaveValue('Keep this question while switching tabs')
    await page.reload()
    await mine.click()
    await expect(editor).toContainText('Send Tarun the quote for fifty seats.')
  } finally { await app.close() }
})
