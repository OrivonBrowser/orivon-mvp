import { describe, expect, it } from 'vitest'
import type { ContentAddress } from '../../broker/policy/pin.js'
import { CONTENT_ROOT_HEADER } from '../fetch/content-root.js'
import type { Fetch } from '../fetch/bundle.js'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { MemoryStorage } from './test-helpers.js'

// An installed app at a name: a moved name is an offer, found from the new
// manifest alone; the bundle is fetched only for the same files republished,
// or once the person has said yes.

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const NEXT_CID = 'bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4'
const THIRD_CID = 'bafybeibwzifw52ttrkqlikfzext5akxu7lz4xiwjgwzmqcpdzmp3n5vnbe'
const CONTENT: ContentAddress = { cid: CID, via: 'ipfs', block: 20_000_000, pointersVerified: true }
const MINUTE = 60_000

interface Seen { readonly url: string, readonly root: string | undefined }

function site (html: string, manifest: Record<string, unknown> = {}): { fetch: Fetch, seen: Seen[] } {
  const inner = stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson(manifest)) }, [`${ORIGIN}/index.html`]: { body: utf8(html) } })
  const seen: Seen[] = []
  return {
    seen,
    fetch: async (url, pinned, signal, headers) => {
      seen.push({ url, root: headers?.[CONTENT_ROOT_HEADER] })
      return await inner(url, pinned, signal, headers)
    }
  }
}

function loaderOver (storage: MemoryStorage, fetch: Fetch, address: () => ContentAddress, clock: { now: number } = { now: 1_700_000_000_000 }): ReturnType<typeof createLoader> {
  return createLoader({ fetch, storage, now: () => clock.now, resolve: PUBLIC_RESOLVER, updateCheckIntervalMs: 60 * MINUTE, contentAddress: async () => address() })
}

async function installedV1 (storage: MemoryStorage): Promise<void> {
  expect((await loaderOver(storage, site('<!doctype html>v1').fetch, () => CONTENT).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
}

describe('createLoader: an installed app at a name that moves', () => {
  it('offers the update after one request, for the new manifest, and downloads no bundle', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const next = site('<!doctype html>v2', { version: '1.0.1' })
    const result = await loaderOver(storage, next.fetch, () => ({ ...CONTENT, cid: NEXT_CID })).load(ORIGIN, NO_GRANTS)
    expect(result).toMatchObject({ outcome: 'update-available', canonicalOrigin: ORIGIN, fromCid: CID, toCid: NEXT_CID, pointersVerified: true, manifest: { version: '1.0.1' } })
    expect(next.seen).toEqual([{ url: MANIFEST_URL, root: NEXT_CID }])
    expect((await loaderOver(storage, next.fetch, () => CONTENT).pinFor(ORIGIN))?.content?.cid).toBe(CID)
  })

  it('carries a DNSLink name\'s unproven pointers into the offer', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const result = await loaderOver(storage, site('<!doctype html>v2', { version: '1.0.1' }).fetch, () => ({ ...CONTENT, cid: NEXT_CID, via: 'dnslink', pointersVerified: false })).load(ORIGIN, NO_GRANTS)
    expect(result).toMatchObject({ outcome: 'update-available', pointersVerified: false })
  })

  it('makes zero requests for a name that has not moved', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const again = site('<!doctype html>v1')
    expect(await loaderOver(storage, again.fetch, () => CONTENT).load(ORIGIN, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(again.seen).toEqual([])
  })

  it('checks again after 5 minutes although the hourly record is fresh, and a restart checks at once', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const clock = { now: 1_700_000_000_000 }
    let at = CONTENT
    const next = site('<!doctype html>v2', { version: '1.0.1' })
    const loader = loaderOver(storage, next.fetch, () => at, clock)
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    at = { ...CONTENT, cid: NEXT_CID }
    clock.now += 4 * MINUTE
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('up-to-date')
    expect(next.seen).toEqual([])
    clock.now += 1 * MINUTE
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('update-available')
    expect((await loaderOver(storage, next.fetch, () => at, clock).load(ORIGIN, NO_GRANTS)).outcome).toBe('update-available')
  })

  it('moves the pin silently when the same files are republished under a new root', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const moved = { ...CONTENT, cid: NEXT_CID, block: 20_000_100 }
    const same = site('<!doctype html>v1')
    expect((await loaderOver(storage, same.fetch, () => moved).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect((await loaderOver(storage, same.fetch, () => moved).pinFor(ORIGIN))?.content).toEqual(moved)
  })

  it('offers an update whose manifest is the same but whose files differ', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const next = site('<!doctype html>v2')
    const result = await loaderOver(storage, next.fetch, () => ({ ...CONTENT, cid: NEXT_CID })).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('update-available')
    expect(next.seen.every((request) => request.root === NEXT_CID)).toBe(true)
    expect((await loaderOver(storage, next.fetch, () => CONTENT).pinFor(ORIGIN))?.content?.cid).toBe(CID)
  })

  it('rejects a moved name whose new manifest is not valid, leaving the pin', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const bad = stubFetch({ [MANIFEST_URL]: { body: utf8('{"orivonApiVersion":1}') } })
    const result = await loaderOver(storage, bad, () => ({ ...CONTENT, cid: NEXT_CID })).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('rejected')
    expect((await loaderOver(storage, bad, () => CONTENT).pinFor(ORIGIN))?.content?.cid).toBe(CID)
  })
})

describe('Loader.applyUpdate', () => {
  it('fetches the offered root and runs the ordinary update decision on it', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const next = site('<!doctype html>v2', { version: '1.0.1' })
    const loader = loaderOver(storage, next.fetch, () => ({ ...CONTENT, cid: NEXT_CID }))
    const result = await loader.applyUpdate(ORIGIN, NEXT_CID, NO_GRANTS)
    expect(result.outcome).toBe('needs-reconsent')
    expect(result.outcome === 'needs-reconsent' && result.content?.cid).toBe(NEXT_CID)
    expect(next.seen.length).toBeGreaterThan(1)
    expect(next.seen.every((request) => request.root === NEXT_CID)).toBe(true)
  })

  it('is refused, with no request, once the name has moved again', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const next = site('<!doctype html>v2', { version: '1.0.1' })
    const result = await loaderOver(storage, next.fetch, () => ({ ...CONTENT, cid: THIRD_CID })).applyUpdate(ORIGIN, NEXT_CID, NO_GRANTS)
    expect(result).toMatchObject({ outcome: 'rejected' })
    expect(result.outcome === 'rejected' && result.reason).toMatch(/moved again/)
    expect(next.seen).toEqual([])
  })

  it('installs at once when the offered files change nothing a person must be asked about', async () => {
    const storage = memoryStorage()
    await installedV1(storage)
    const moved = { ...CONTENT, cid: NEXT_CID }
    const result = await loaderOver(storage, site('<!doctype html>v1').fetch, () => moved).applyUpdate(ORIGIN, NEXT_CID, NO_GRANTS)
    expect(result.outcome).toBe('installed')
    expect((await loaderOver(storage, site('').fetch, () => moved).pinFor(ORIGIN))?.content?.cid).toBe(NEXT_CID)
  })
})
