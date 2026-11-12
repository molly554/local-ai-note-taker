import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Pause keeps the same note and frozen captured time; Resume continues and Finish writes notes', async () => {
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
    ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: mkdtempSync(join(tmpdir(), 'yogurt-pause-')),
  } })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(5000)
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep the customer feedback from this meeting.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toBeVisible()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    const paused = await page.evaluate(() => window.yogurt.widget.state())
    expect(paused).toMatchObject({ meetingId: id, paused: true, kind: 'recording' })
    await page.waitForTimeout(1100)
    expect((await page.evaluate(() => window.yogurt.widget.state()))?.elapsedMs).toBe(paused!.elapsedMs)
    expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toMatchObject({ paused: true, state: 'recording' })
    expect(await page.evaluate((id) => window.yogurt.meetings.delete(id), id)).toBe('recording')
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('past-note')).toContainText('Paused')
    await page.getByTestId('past-note').click()
    await page.getByTestId('note-notes-tab').click()
    await expect(page.getByRole('textbox', { name: 'My notes', exact: true })).toContainText('Keep the customer feedback')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    const resume = page.getByRole('button', { name: 'Resume recording', exact: true })
    const finish = page.getByRole('button', { name: 'Finish recording', exact: true })
    await expect(resume).toBeVisible()
    await expect(finish).toBeVisible()
    const a = (await resume.boundingBox())!, b = (await finish.boundingBox())!
    expect(a.x + a.width).toBeLessThanOrEqual(b.x)
    expect(b.x + b.width).toBeLessThanOrEqual(720)
    await resume.click()
    await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.yogurt.widget.state()))!.elapsedMs).toBeGreaterThan(paused!.elapsedMs)
    await finish.click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', /^(stopped|done)$/)
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 30_000 }).toBe('done')
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toContain('Keep the customer feedback')
    expect(await page.evaluate((id) => window.yogurt.audio.tracks(id), id)).toEqual(['me', 'them'])
  } finally { await app.close() }
})
