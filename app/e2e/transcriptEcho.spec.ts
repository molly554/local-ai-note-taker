import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// CI only: never run Electron E2E on the guarded development Mac.
test('echo disclosures stay inline, remember expansion, and permanently restore one line', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-inline-echo-'))
  const app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  let db: DatabaseSync | undefined
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('home')).toBeVisible()
    const id = await app.evaluate(() => (globalThis as any).__fake__.bigMeeting(1)) as string
    db = new DatabaseSync(join(userData, 'yogurt.db'))
    db.prepare('DELETE FROM segments WHERE meeting_id=?').run(id)
    const add = db.prepare('INSERT INTO segments(meeting_id,track,start_ms,end_ms,text,speaker,hidden) VALUES(?,?,?,?,?,?,?)')
    for (const [i, hidden] of [false, true, true, false, true].entries()) add.run(id, hidden ? 'me' : 'them', i * 3000, i * 3000 + 1000, `Speech ${i}`, null, Number(hidden))
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(page.getByTestId('transcript-hidden-toggle')).toHaveCount(0)
    await expect(page.getByTestId('transcript-duplicate-help')).toHaveCount(0)
    const groups = page.getByTestId('transcript-echo')
    await expect(groups).toHaveCount(2)
    await expect(groups.first()).toContainText('2 echoed lines')
    await expect(groups.last()).toContainText('1 echoed line')
    await groups.first().getByRole('button').press('Enter')
    await expect(page.getByTestId('transcript-line')).toHaveCount(4)
    await page.getByTestId('nav-home').click()
    await page.evaluate(id => window.yogurt.nav.go(`/note/${id}`), id)
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click()
    await expect(groups.first().getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('transcript-restore').first().focus()
    await page.getByTestId('transcript-restore').first().press('Enter')
    await expect(groups.first()).toContainText('1 echoed line')
    await expect(page.getByTestId('transcript-line').filter({ hasText: 'Speech 1' })).not.toHaveAttribute('data-hidden')
    expect((await page.evaluate(id => window.yogurt.transcript.get(id), id)).map(l => l.text)).toEqual(['Speech 0', 'Speech 1', 'Speech 3'])
  } finally { db?.close(); await app.close() }
})
