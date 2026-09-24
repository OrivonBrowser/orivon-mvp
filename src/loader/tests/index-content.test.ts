import { describe, expect, it } from 'vitest'
import type { ContentAddress } from '../../broker/policy/pin.js'
import { CONTENT_ROOT_HEADER } from '../content-root.js'
import type { Fetch } from '../fetch-bundle.js'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { MemoryStorage } from './test-helpers.js'

// A bundle fetched from IPFS: every request of one load names the root CID
// it began with, the pin records where the bundle came from, and an
// unchanged root is recognised without asking for anything.

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const NEXT_CID = 'bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4'
const CONTENT: ContentAddress = { cid: CID, via: 'ipfs', block: 20_000_000, pointersVerified: true }

function recording (html: string): { fetch: Fetch, seen: Array<{ url: string, root: string | undefined }> } {
  const inner = stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson()) }, [`${ORIGIN}/index.html`]: { body: utf8(html) } })
  const seen: Array<{ url: string, root: string | undefined }> = []
  return {
    seen,
    fetch: async (url, pinned, signal, headers) => {
      seen.push({ url, root: headers?.[CONTENT_ROOT_HEADER] })
      return await inner(url, pinned, signal, headers)
    }
  }
}

function loader (storage: MemoryStorage, fetch: Fetch, address: () => Promise<ContentAddress | undefined>): ReturnType<typeof createLoader> {
  return createLoader({ fetch, storage, now: () => 1_700_000_000_000, resolve: PUBLIC_RESOLVER, updateCheckIntervalMs: 0, contentAddress: async () => await address() })
}

describe('createLoader: a bundle from a content-addressed origin', () => {
  it('pins every request of the load to the root, and records where the bundle came from', async () => {
    const storage = memoryStorage()
    const { fetch, seen } = recording('<!doctype html>v1')
    const l = loader(storage, fetch, async () => CONTENT)
    expect((await l.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((request) => request.root === CID)).toBe(true)
    expect((await l.pinFor(ORIGIN))?.content).toEqual(CONTENT)
  })

  it('recognises an unchanged root without a single request', async () => {
    const storage = memoryStorage()
    await loader(storage, recording('<!doctype html>v1').fetch, async () => CONTENT).load(ORIGIN, NO_GRANTS)
    const again = recording('<!doctype html>v1')
    expect(await loader(storage, again.fetch, async () => CONTENT).load(ORIGIN, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(again.seen).toEqual([])
  })

  it('fetches under the new root once the name points elsewhere', async () => {
    const storage = memoryStorage()
    await loader(storage, recording('<!doctype html>v1').fetch, async () => CONTENT).load(ORIGIN, NO_GRANTS)
    const next = recording('<!doctype html>v2')
    const result = await loader(storage, next.fetch, async () => ({ ...CONTENT, cid: NEXT_CID })).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('needs-reconsent')
    expect(result.outcome === 'needs-reconsent' && result.content?.cid).toBe(NEXT_CID)
    expect(next.seen.every((request) => request.root === NEXT_CID)).toBe(true)
  })

  it('moves the pin to a new root that holds the same bundle, so the next check asks for nothing', async () => {
    const storage = memoryStorage()
    await loader(storage, recording('<!doctype html>v1').fetch, async () => CONTENT).load(ORIGIN, NO_GRANTS)
    const pinnedAt = (await loader(storage, recording('').fetch, async () => CONTENT).pinFor(ORIGIN))?.pinnedAt
    const moved = { ...CONTENT, cid: NEXT_CID, block: 20_000_100 }
    await loader(storage, recording('<!doctype html>v1').fetch, async () => moved).load(ORIGIN, NO_GRANTS)
    const pin = await loader(storage, recording('').fetch, async () => moved).pinFor(ORIGIN)
    expect(pin?.content).toEqual(moved)
    expect(pin?.pinnedAt).toBe(pinnedAt)
    const third = recording('<!doctype html>v1')
    expect(await loader(storage, third.fetch, async () => moved).load(ORIGIN, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(third.seen).toEqual([])
  })

  it('is rejected, before any request, when the name cannot be verified', async () => {
    const { fetch, seen } = recording('<!doctype html>v1')
    const result = await loader(memoryStorage(), fetch, async () => { throw new Error('the light client is still syncing') }).load(ORIGIN, NO_GRANTS)
    expect(result).toEqual({ outcome: 'rejected', reason: `${ORIGIN}'s content could not be verified: the light client is still syncing` })
    expect(seen).toEqual([])
  })

  it('leaves an origin with no content address exactly as before', async () => {
    const storage = memoryStorage()
    const { fetch, seen } = recording('<!doctype html>v1')
    expect((await loader(storage, fetch, async () => undefined).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(seen.every((request) => request.root === undefined)).toBe(true)
    expect(await loader(storage, fetch, async () => undefined).pinFor(ORIGIN)).not.toHaveProperty('content')
  })
})
