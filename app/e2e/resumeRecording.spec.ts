import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')
async function launch(profile: string, env: Record<string, string> = {}) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile, YOGURT_FAKE_LLM_MS: '1', ...env } })
  app.context().setDefaultTimeout(5000)
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page }
}

test('a finished note resumes after reopening, preserves original data, confirms edited Summary, and appends audio', async () => {
  test.setTimeout(90_000)
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-resume-'))
  let { app, page } = await launch(profile)
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.evaluate((id) => window.yogurt.meetings.rename(id, 'Resume safety fixture'), id)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep this original decision.')
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status).toBe('done')
    const prior = await page.evaluate(async (id) => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), transcript: await window.yogurt.transcript.get(id) }), id)
    const dir = join(profile, 'meetings', id), originalAudio = readFileSync(join(dir, 'me.wav'))
    await app.close()
    ;({ app, page } = await launch(profile))
    await page.getByTestId('past-note').click()
    await page.getByRole('textbox', { name: 'Summary', exact: true }).fill('My edited summary is kept until I confirm.')
    await page.getByTestId('note-resume').click()
    await expect(page.getByTestId('resume-cancel')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('resume-confirm')).toHaveCount(0)
    await expect(page.getByTestId('note-resume')).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Summary', exact: true })).toHaveText('My edited summary is kept until I confirm.')
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)

    // A bad retained part refuses Resume without changing the saved note or its previous audio.
    writeFileSync(join(dir, 'part.1.json'), JSON.stringify({ startMs: 5000 }))
    writeFileSync(join(dir, 'me.1.wav'), 'unreadable fixture')
    await page.getByTestId('note-resume').click(); await page.getByTestId('resume-yes').click()
    await expect(page.getByTestId('note-resume-failed')).toBeVisible()
    expect((await page.evaluate((id) => window.yogurt.meetings.get(id), id))?.state).toBe('done')
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)
    unlinkSync(join(dir, 'part.1.json')); unlinkSync(join(dir, 'me.1.wav'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))!.setSize(720, 520))
    await page.getByTestId('note-resume').click(); await page.getByTestId('resume-yes').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    expect(await page.evaluate((id) => window.yogurt.meetings.get(id), id)).toMatchObject({ id, startedAt: prior.meeting!.startedAt, title: prior.meeting!.title })
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).mine).toBe(prior.notes.mine)
    expect(await page.evaluate((id) => window.yogurt.transcript.get(id), id)).toEqual(prior.transcript)
    expect(readFileSync(join(dir, 'me.wav'))).toEqual(originalAudio)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Keep this original decision.\nAdd this resumed decision.')
    await page.waitForTimeout(1500)
    await page.getByTestId('note-pause').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-paused', 'true')
    await page.getByTestId('note-pause').click()
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 20_000 }).toBe('done')
    const next = await page.evaluate(async (id) => ({ meeting: await window.yogurt.meetings.get(id), notes: await window.yogurt.notes.get(id), transcript: await window.yogurt.transcript.get(id) }), id)
    expect(next.meeting).toMatchObject({ id, startedAt: prior.meeting!.startedAt, title: prior.meeting!.title })
    expect(next.meeting!.durationMs).toBeGreaterThan(0)
    expect(next.notes.mine).toContain('Add this resumed decision.')
    expect(next.transcript.length).toBeGreaterThan(prior.transcript.length)
    for (const line of prior.transcript) expect(next.transcript.find((v) => v.id === line.id)).toEqual(line)
    const combined = readFileSync(join(dir, 'me.wav'))
    expect(combined.length).toBeGreaterThan(originalAudio.length)
    expect(combined.subarray(44, originalAudio.length)).toEqual(originalAudio.subarray(44))
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)
  } finally { await app.close() }
})

test('Finish blocks Resume while Summary is processing, then recording can resume', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'yogurt-resume-writing-'))
  const { app, page } = await launch(profile, { YOGURT_FAKE_LLM_MS: '120' })
  try {
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    await page.getByTestId('note-notes-tab').click()
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('First session manual note.')
    await page.waitForTimeout(800)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status).toBe('writing')
    await expect(page.getByTestId('note-resume')).toBeDisabled()
    await expect(page.getByTestId('note-resume')).toHaveText('Summarizing…')
    await page.getByTestId('nav-chat').click()
    await page.evaluate((id) => window.yogurt.nav.go(`/note/${id}`), id)
    await expect(page.getByTestId('note-resume')).toBeDisabled()
    await expect(page.getByTestId('note-resume')).toBeEnabled({ timeout: 30_000 })
    await expect(page.getByTestId('note-resume')).toHaveText('Resume recording')
    await page.getByTestId('note-resume').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await expect(page.getByTestId('note-notes-tab')).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('textbox', { name: 'My notes', exact: true }).fill('Second session decision, with the first session retained.')
    await app.evaluate(() => { process.env.YOGURT_FAKE_LLM_MS = '1' })
    await page.waitForTimeout(800)
    await page.getByTestId('note-stop').click()
    await expect.poll(async () => (await page.evaluate((id) => window.yogurt.notes.get(id), id)).status, { timeout: 20_000 }).toBe('done')
    expect((await page.evaluate((id) => window.yogurt.notes.get(id), id)).enhanced).toContain('Second session decision')
    expect(await page.evaluate(() => window.yogurt.meetings.cards({ limit: 10 }))).toHaveLength(1)
  } finally { await app.close() }
})


test('queued summaries block Resume and unsuccessful or empty summaries release it', async () => {
  const { app, page } = await launch(mkdtempSync(join(tmpdir(), 'yogurt-summary-states-')))
  try {
    const id = await app.evaluate(() => (globalThis as unknown as { __fake__: { bigMeeting(n: number): string } }).__fake__.bigMeeting(10))
    await page.evaluate((id) => window.yogurt.nav.go(`/note/${id}`), id)
    const notes = await page.evaluate((id) => window.yogurt.notes.get(id), id)
    for (const status of ['waiting', 'failed', 'writing', 'empty'] as const) {
      await app.evaluate(({ BrowserWindow }, view) => {
        BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('#'))!.webContents.send('notes:changed', view)
      }, { ...notes, status })
      if (status === 'waiting' || status === 'writing') await expect(page.getByTestId('note-resume')).toBeDisabled()
      else await expect(page.getByTestId('note-resume')).toBeEnabled()
    }
  } finally { await app.close() }
})
