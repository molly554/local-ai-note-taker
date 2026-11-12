import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

/** a service on this computer that speaks the OpenAI chat API: it keeps what it was asked and answers with fixed notes */
async function service() {
  const asked: Array<{ auth: string | undefined; path: string; prompt: string; model: string }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> }
      asked.push({ auth: req.headers.authorization, path: req.url ?? '', prompt: body.messages.at(-1)!.content, model: body.model })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of ['## From the cloud\n', '- Written by the service\n', '## Next steps\n', '- **You:** Check the bill'])
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, asked, close: () => server.close() }
}

test('Cloud AI: off until turned on; then the notes come from the service, and its key is never kept in plain text', async () => {
  const cloud = await service()
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-cloud-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  const settingsFile = () => readFileSync(join(userData, 'settings.json'), 'utf8')
  try {
    await expect(page.getByTestId('home')).toBeVisible()
    await page.getByTestId('settings-open').click()
    const toggle = page.getByTestId('cloud-toggle')
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('cloud-url')).toHaveCount(0)
    await expect(page.getByTestId('cloud-ai')).toContainText('your transcripts, your own notes and your questions are sent to the service below')
    await expect(page.getByTestId('cloud-ai')).toContainText('Recordings are never sent.')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('cloud-url').fill(cloud.url)
    await page.getByTestId('cloud-model').fill('some-model')
    await page.getByTestId('cloud-key').fill('plain-test-key')
    await page.getByTestId('cloud-model').focus()
    // the key field empties and says one is kept; the file has the address and the model, and the key only sealed
    await expect(page.getByTestId('cloud-key')).toHaveValue('')
    await expect(page.getByTestId('cloud-key')).toHaveAttribute('placeholder', 'Saved. Type a new key to replace it.')
    await expect.poll(() => JSON.parse(settingsFile()).cloud).toMatchObject({ on: true, url: cloud.url, model: 'some-model' })
    expect(JSON.parse(settingsFile()).cloud.key).toBeTruthy()
    expect(settingsFile()).not.toContain('plain-test-key')

    // a meeting: its notes are what the service wrote, asked with the key and the transcript
    await page.getByTestId('nav-home').click()
    await page.getByTestId('new-note').click()
    await expect(page.getByTestId('note-state')).toHaveAttribute('data-state', 'recording')
    await page.getByTestId('note-transcript-toggle').click()
    await expect(page.getByTestId('transcript-line').first()).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('note-stop').click()
    await expect(page.getByText('Written by the service')).toBeVisible({ timeout: 60_000 })
    expect(cloud.asked.length).toBeGreaterThan(0)
    for (const a of cloud.asked) { expect(a.auth).toBe('Bearer plain-test-key'); expect(a.path).toBe('/v1/chat/completions'); expect(a.model).toBe('some-model') }
    expect(cloud.asked.some((a) => a.prompt.includes('launch plan'))).toBe(true)

    // turned off again: the model on this computer writes the next ones, and the service hears nothing more
    await page.getByTestId('settings-open').click()
    await page.getByTestId('cloud-toggle').scrollIntoViewIfNeeded()
    await page.getByTestId('cloud-toggle').click()
    await expect(page.getByTestId('cloud-toggle')).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => JSON.parse(settingsFile()).cloud?.on).toBeUndefined()
  } finally {
    await app.close()
    cloud.close()
  }
})
