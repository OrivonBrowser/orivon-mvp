import { describe, expect, it, vi } from 'vitest'
import { createLoader, UPDATE_CHECK_INTERVAL_MS } from '../index.js'
import type { Fetch, FetchResponse, LoadContext } from '../index.js'
import { checkedRecently, conditionalHeaders, parseUpdateCheckRecord, validatorsFrom } from '../update-check.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, utf8 } from './test-helpers.js'

// An installed app is checked at most once an interval, and the interval
// survives a restart; a check of an unchanged app is one conditional request
// for its manifest, answered 304, instead of a download of the bundle.

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const HOUR = UPDATE_CHECK_INTERVAL_MS

interface Served { manifest: string, etag?: string, lastModified?: string }

function response (status: number, body: string | null, headers: Record<string, string> = {}): FetchResponse {
  const bytes = body === null ? null : utf8(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: bytes === null ? null : new ReadableStream({ start (controller) { controller.enqueue(bytes); controller.close() } }),
    arrayBuffer: async () => (bytes ?? new Uint8Array()).buffer as ArrayBuffer
  }
}

/** A static host that honours If-None-Match / If-Modified-Since on the manifest, the way real ones do. */
function conditionalHost (served: Served): Fetch & { calls: Array<{ url: string, headers: Readonly<Record<string, string>> | undefined }> } {
  const calls: Array<{ url: string, headers: Readonly<Record<string, string>> | undefined }> = []
  const fetch = async (url: string, _addresses: readonly string[], _signal: AbortSignal, headers?: Readonly<Record<string, string>>): Promise<FetchResponse> => {
    calls.push({ url, headers })
    if (url !== MANIFEST_URL) return response(200, '<!doctype html>')
    const validators = { ...(served.etag !== undefined && { etag: served.etag }), ...(served.lastModified !== undefined && { 'last-modified': served.lastModified }) }
    const unchanged = (served.etag !== undefined && headers?.['if-none-match'] === served.etag) ||
      (served.etag === undefined && served.lastModified !== undefined && headers?.['if-modified-since'] === served.lastModified)
    return unchanged ? response(304, null, validators) : response(200, served.manifest, validators)
  }
  return Object.assign(fetch, { calls })
}

function loaderFor (fetch: Fetch, storage: ReturnType<typeof memoryStorage>, clock: { now: number }): ReturnType<typeof createLoader> {
  return createLoader({ fetch, storage, now: () => clock.now, resolve: PUBLIC_RESOLVER, updateCheckIntervalMs: HOUR })
}

describe('the update-check interval survives a restart', () => {
  it('a new loader over the same storage answers up-to-date without any request, until the interval passes', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const host = conditionalHost({ manifest: manifestJson(), etag: '"v1"' })
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    const afterInstall = host.calls.length

    clock.now = HOUR - 1
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    expect(host.calls.length).toBe(afterInstall)
  })

  it('checks again when the stored time is in the future (the clock went back)', async () => {
    const storage = memoryStorage()
    const clock = { now: 10 * HOUR }
    const host = conditionalHost({ manifest: manifestJson() })
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)

    clock.now = 0
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
  })

  it('ignores a malformed stored record and checks in full', async () => {
    const storage = memoryStorage()
    await storage.writeUpdateCheck(ORIGIN, { checkedAt: 'yesterday' } as never)
    const host = conditionalHost({ manifest: manifestJson(), etag: '"v1"' })
    expect((await loaderFor(host, storage, { now: 0 }).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
  })
})

describe('a check once the interval has passed', () => {
  it('costs one conditional manifest request when nothing changed, and restarts the interval', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const host = conditionalHost({ manifest: manifestJson(), etag: '"v1"' })
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)
    const afterInstall = host.calls.length

    clock.now = HOUR
    const loader = loaderFor(host, storage, clock)
    expect(await loader.load(ORIGIN, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(host.calls.slice(afterInstall)).toEqual([{ url: MANIFEST_URL, headers: { 'if-none-match': '"v1"' } }])

    clock.now = 2 * HOUR - 1
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    expect(host.calls.length).toBe(afterInstall + 1)
  })

  it('falls back to If-Modified-Since when the host sends no ETag', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const host = conditionalHost({ manifest: manifestJson(), lastModified: 'Tue, 22 Sep 2026 10:00:00 GMT' })
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)

    clock.now = HOUR
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    expect(host.calls.at(-1)?.headers).toEqual({ 'if-modified-since': 'Tue, 22 Sep 2026 10:00:00 GMT' })
  })

  it('downloads a changed manifest\'s bundle, and once it is pinned conditions later checks on the new ETag', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const served: Served = { manifest: manifestJson(), etag: '"v1"' }
    const host = conditionalHost(served)
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)

    served.manifest = manifestJson({ version: '1.1.0' })
    served.etag = '"v2"'
    clock.now = HOUR
    const loader = loaderFor(host, storage, clock)
    const updated = await loader.load(ORIGIN, NO_GRANTS)
    expect(updated.outcome).toBe('needs-reconsent')
    expect(host.calls.at(-1)?.url).toBe(`${ORIGIN}/index.html`)
    if (updated.outcome !== 'needs-reconsent') return
    expect((await loader.installFetched(ORIGIN, updated.manifest, updated.tree, updated.entries, updated.declaration, undefined)).outcome).toBe('installed')

    // The record still names v1's manifest, which is no longer pinned: one full check re-learns the validators.
    clock.now = 2 * HOUR
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(host.calls.at(-2)?.headers).toBeUndefined()

    clock.now = 3 * HOUR
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    expect(host.calls.at(-1)).toEqual({ url: MANIFEST_URL, headers: { 'if-none-match': '"v2"' } })
  })

  it('never conditions a check on validators that do not describe the pinned manifest', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const host = conditionalHost({ manifest: manifestJson(), etag: '"v1"' })
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)
    // Something else pins a different manifest (an accepted prompt's installFetched does).
    await storage.writeAsset(ORIGIN, '/.well-known/orivon.json', utf8(manifestJson({ version: '9.9.9' })))
    const pin = storage.pins.get(ORIGIN) as { assets: Array<{ path: string, leaf: string }> }
    storage.pins.set(ORIGIN, { ...pin, assets: pin.assets.map((asset) => asset.path === '/.well-known/orivon.json' ? { ...asset, leaf: `sha256:${'0'.repeat(64)}` } : asset) })

    clock.now = HOUR
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)
    expect(host.calls.at(-2)?.headers).toBeUndefined()
  })

  it('keeps the pinned manifest\'s validators through a pending prompt, and asks again next interval', async () => {
    const storage = memoryStorage()
    const clock = { now: 0 }
    const served: Served = { manifest: manifestJson(), etag: '"v1"' }
    const host = conditionalHost(served)
    await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)

    served.manifest = manifestJson({ version: '2.0.0', capabilities: { fs: { quotaBytes: 1024 } } })
    served.etag = '"v2"'
    clock.now = HOUR
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('needs-capability-prompt')

    clock.now = 2 * HOUR
    expect((await loaderFor(host, storage, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('needs-capability-prompt')
    expect(host.calls.find((call) => call.url === MANIFEST_URL && call.headers?.['if-none-match'] === '"v2"')).toBeUndefined()
  })

  it('records nothing for a rejected check, so the next visit retries', async () => {
    const storage = memoryStorage()
    const fetch = vi.fn(async () => { throw new Error('offline') })
    await loaderFor(fetch, storage, { now: 0 }).load(ORIGIN, NO_GRANTS)
    expect(await storage.readUpdateCheck(ORIGIN)).toBeUndefined()
  })
})

describe('update-check.ts', () => {
  it('keeps only header-safe validators', () => {
    const headers = (map: Record<string, string>): FetchResponse => response(200, null, map)
    expect(validatorsFrom(headers({ etag: '"abc"', 'last-modified': 'Tue, 22 Sep 2026 10:00:00 GMT' }))).toEqual({ etag: '"abc"', lastModified: 'Tue, 22 Sep 2026 10:00:00 GMT' })
    expect(validatorsFrom(headers({ etag: '"a"\r\nx-injected: 1' }))).toBeUndefined()
    expect(validatorsFrom(headers({ etag: 'x'.repeat(1025) }))).toBeUndefined()
    expect(validatorsFrom(headers({}))).toBeUndefined()
  })

  it('builds the conditional headers from whichever validators exist', () => {
    expect(conditionalHeaders({ etag: '"a"' })).toEqual({ 'if-none-match': '"a"' })
    expect(conditionalHeaders({ lastModified: 'd' })).toEqual({ 'if-modified-since': 'd' })
  })

  it('treats only the past interval as recent', () => {
    expect(checkedRecently(0, 10, 100)).toBe(true)
    expect(checkedRecently(0, 100, 100)).toBe(false)
    expect(checkedRecently(50, 10, 100)).toBe(false)
  })

  it('reads back a record defensively', () => {
    const leaf = `sha256:${'a'.repeat(64)}`
    expect(parseUpdateCheckRecord({ checkedAt: 5, validators: { etag: '"a"' }, manifestLeaf: leaf })).toEqual({ checkedAt: 5, validators: { etag: '"a"' }, manifestLeaf: leaf })
    expect(parseUpdateCheckRecord({ checkedAt: 5, validators: { etag: '"a"' } })).toEqual({ checkedAt: 5 })
    expect(parseUpdateCheckRecord({ checkedAt: 5, validators: { etag: 'bad\n' }, manifestLeaf: leaf })).toEqual({ checkedAt: 5 })
    expect(parseUpdateCheckRecord({ checkedAt: Number.NaN })).toBeUndefined()
    expect(parseUpdateCheckRecord('5')).toBeUndefined()
    expect(parseUpdateCheckRecord(null)).toBeUndefined()
  })
})
