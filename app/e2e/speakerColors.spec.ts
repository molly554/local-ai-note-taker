import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const names = ['Ada Chen', 'Ben Ortiz', 'Cy Patel', 'Dee Morgan', 'Eli Ross', 'Fay Kim', 'Gia Lee']
for (const theme of ['light', 'dark'] as const) test(`speaker colours agree across the note and recent preview in ${theme}`, async ({}, info) => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-speaker-colors-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_BACKGROUND: '1', YOGURT_USER_DATA: userData,
  } })
  let db: DatabaseSync | undefined
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.setContentSize(1200, 850))
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = await page.evaluate(async () => (await window.yogurt.nav.current()).slice('/note/'.length))
    db = new DatabaseSync(join(userData, 'yogurt.db'))
    const insert = db.prepare('INSERT INTO segments(meeting_id,track,start_ms,end_ms,text,speaker) VALUES(?,?,?,?,?,?)')
    // These first appearances are outside the preview's initial 80-line slice.
    for (let i = 0; i < names.length; i++) insert.run(id, 'them', 100000 + i * 3000, 101000 + i * 3000, 'Earlier discussion.', names[i])
    for (let i = 0; i < 80; i++) insert.run(id, 'me', 200000 + i * 3000, 201000 + i * 3000, 'Taking notes.', 'Me')
    for (let i = names.length - 1; i >= 0; i--) insert.run(id, 'them', 500000 + (names.length - 1-i) * 3000, 501000 + (names.length - 1-i) * 3000, 'The next step is clear.', names[i])
    await page.reload()
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.getByTestId('note-transcript-toggle').click()
    const noteNames = page.getByTestId('transcript-who')
    for (let i = 0; i < names.length; i++) await expect(noteNames.filter({ hasText: names[i] }).last()).toHaveAttribute('data-color', String(i))
    await expect(noteNames.filter({ hasText: 'You' }).first()).not.toHaveAttribute('data-color')
    await page.getByTestId('transcript').evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect.poll(() => app.windows().some(p => p.url().includes('#widget'))).toBe(true)
    const preview = app.windows().find(p => p.url().includes('#widget'))!
    await preview.reload()
    await preview.getByTestId('widget').hover()
    await expect(preview.getByTestId('widget')).toHaveAttribute('data-open', 'true')
    await preview.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await expect(preview.getByTestId('widget-preview-loading')).toHaveCount(0)
    const previewNames = preview.locator('.widget-preview-speaker')
    for (let i = 0; i < names.length; i++) await expect(previewNames.filter({ hasText: names[i] })).toHaveAttribute('data-color', String(i))
    await expect(previewNames.filter({ hasText: 'You' }).first()).not.toHaveAttribute('data-color')
    await preview.getByTestId('widget-preview-text').evaluate(el => { el.scrollTop = el.scrollHeight })
    // The app appearance changes the note palette; the floating preview always stays dark.
    const noteColour = await noteNames.filter({ hasText: names[0] }).last().evaluate(el => getComputedStyle(el).color)
    const previewColour = await previewNames.filter({ hasText: names[0] }).evaluate(el => getComputedStyle(el).color)
    expect(noteColour).toBe(theme === 'dark' ? 'rgb(185, 149, 255)' : 'rgb(116, 52, 202)')
    expect(previewColour).toBe('rgb(185, 149, 255)')
    await preview.reload()
    await preview.getByTestId('widget').hover()
    await expect(preview.locator('.widget-preview-speaker').filter({ hasText: names[0] })).toHaveAttribute('data-color', '0')
    // An earlier unidentified line gaining a name must not shift existing colours.
    insert.run(id, 'them', 90000, 91000, 'A late attribution.', 'Hal Moss')
    const saved = await page.evaluate(id => window.yogurt.transcript.get(id, { hidden: true }), id)
    expect(saved.find(s => s.speaker === 'Hal Moss')?.speakerColor).toBe(0)
    expect(saved.find(s => s.speaker === names[0])?.speakerColor).toBe(0)
    expect(saved.find(s => s.speaker === names[6])?.speakerColor).toBe(6)
    // Capture ordinary turn lengths, separately from the seven-slot / 80-line regression above.
    db.prepare('DELETE FROM segments WHERE meeting_id = ?').run(id)
    await page.evaluate(id => window.yogurt.meetings.rename(id, 'Trial review'), id)
    const exchange = [
      [names[0], 'The trial team got through setup without needing our help.'],
      [names[1], "That's encouraging."],
      [names[2], 'They still missed the invite email. I can make the next step clearer.'],
      [names[0], "Let's test the new wording with tomorrow's group."],
      ['You', "I'll bring the revised email."],
      [names[1], 'Should we watch them go through it?'],
      [names[2], 'Yes, and leave time for questions.'],
      [names[0], "Good, let's compare what we learn on Friday."],
    ]
    for (const [i, [speaker, text]] of exchange.entries()) insert.run(id, speaker === 'You' ? 'me' : 'them', 600000 + i * 8000, 606000 + i * 8000, text, speaker)
    await page.reload()
    await page.getByTestId('note-transcript-toggle').click()
    await preview.reload()
    await preview.getByTestId('widget').hover()
    await expect(preview.getByText(exchange[0][1], { exact: true })).toBeVisible()
    for (const [surface, target, scroll, turn] of [
      ['note', page, '[data-testid="transcript"]', '[data-testid="transcript-turn"]'],
      ['preview', preview, '[data-testid="widget-preview-text"]', '.widget-preview-turn'],
    ] as const) {
      await target.getByText(exchange[0][1], { exact: true }).evaluate((el, { scroll, turn }) => {
        const list = document.querySelector(scroll)!, first = el.closest(turn)!
        list.scrollTop += first.getBoundingClientRect().top - list.getBoundingClientRect().top - 16
      }, { scroll, turn })
      await target.screenshot({ path: info.outputPath(`speakers-${surface}-${theme}.png`) })
    }
    await preview.getByTestId('widget-preview-text').evaluate(el => { el.scrollTop = el.scrollHeight })
    await preview.screenshot({ path: info.outputPath(`speakers-preview-continuation-${theme}.png`) })
  } finally { db?.close(); await app.close() }
})
