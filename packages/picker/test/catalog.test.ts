import { describe, expect, it } from 'vitest'
import { validateCatalog } from '../src/catalog-schema'
import real from '../../../catalog/catalog.json'
import licenses from '../../../catalog/licenses.json'
import { models } from './fixtures'

const shipped = real as Record<string, unknown>
const sha = /^[a-f0-9]{64}$/

describe('validateCatalog', () => {
  it('accepts the shipped catalog', () => {
    const r = validateCatalog(real, licenses)
    expect(r.ok ? [] : r.errors).toEqual([])
  })
  it('pins every ASR model with a sha256', () => {
    const r = validateCatalog(real, licenses)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.catalog.asr.length).toBeGreaterThanOrEqual(2)
    for (const a of r.catalog.asr) expect(a.sha256).toMatch(sha)
  })
  it('takes a whisper-server entry that is bundled in the app: nothing to download', () => {
    const r = validateCatalog(real, licenses)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.catalog.whisperServer.bundled).toBe(true)
    expect(r.catalog.whisperServer.url).toBeUndefined()
  })
  it('rejects a whisper-server entry that is neither pending nor bundled and has no sha256', () => {
    const bad = { ...shipped, whisperServer: { id: 'whisper-server', tag: 'v1.9.5' } }
    expect(validateCatalog(bad, licenses).ok).toBe(false)
  })
  it('pins the embedding model (meaning search across meetings) with a sha256, its size and its vector length', () => {
    const r = validateCatalog(real, licenses)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.catalog.embedding.sha256).toMatch(sha)
    expect(r.catalog.embedding.url).toMatch(/\/resolve\/[a-f0-9]{40}\//)
    expect(r.catalog.embedding.dims).toBeGreaterThan(0)
  })
  it('rejects an embedding model without a sha256, or with a disallowed license', () => {
    const embedding = shipped.embedding as Record<string, unknown>
    expect(validateCatalog({ ...shipped, embedding: { ...embedding, sha256: '' } }, licenses).ok).toBe(false)
    expect(validateCatalog({ ...shipped, embedding: { ...embedding, license: 'CC-BY-NC-4.0' } }, licenses).ok).toBe(false)
  })
  it('rejects an ASR model without a sha256', () => {
    const asr = (shipped.asr as Record<string, unknown>[]).map((a) => ({ ...a, sha256: '' }))
    expect(validateCatalog({ ...shipped, asr }, licenses).ok).toBe(false)
  })
  it('rejects disallowed licenses', () => {
    const r = validateCatalog({ ...shipped, models: [{ ...models[0], license: 'CC-BY-NC-4.0' }] }, licenses)
    expect(r.ok).toBe(false)
  })
  it('rejects a disallowed ASR license', () => {
    const asr = (shipped.asr as Record<string, unknown>[]).map((a) => ({ ...a, license: 'CC-BY-NC-4.0' }))
    expect(validateCatalog({ ...shipped, asr }, licenses).ok).toBe(false)
  })
  it('rejects duplicate ids', () => {
    const r = validateCatalog({ ...shipped, models: [models[0], models[0]] }, licenses)
    expect(r.ok).toBe(false)
  })
  it('rejects missing sha256', () => {
    const bad = { ...models[0], builds: [{ ...models[0].builds[0], sha256: '' }] }
    expect(validateCatalog({ ...shipped, models: [bad] }, licenses).ok).toBe(false)
  })
  it('requires at least one starter model', () => {
    expect(validateCatalog({ ...shipped, models: [models[3]] }, licenses).ok).toBe(false)
  })
})
