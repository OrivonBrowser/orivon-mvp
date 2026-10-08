import { describe, expect, it, vi } from 'vitest'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const ROUTES = {
  [MANIFEST_URL]: { body: utf8(manifestJson()) },
  [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
}

describe('createLoader: updateCheckIntervalMs', () => {
  it('answers up-to-date without fetching when the last completed check is within the interval, and checks again once it has passed', async () => {
    let now = 1_000
    const fetch = vi.fn(stubFetch(ROUTES))
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => now, resolve: PUBLIC_RESOLVER, updateCheckIntervalMs: 60_000 })

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    const fetchesAfterFirst = fetch.mock.calls.length

    now += 59_000
    expect(await loader.load(`${ORIGIN}/deep/link`, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(fetch.mock.calls.length).toBe(fetchesAfterFirst)

    now += 2_000
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(fetch.mock.calls.length).toBeGreaterThan(fetchesAfterFirst)
  })

  it('does not hold back a retry after a rejected check', async () => {
    const fetch = vi.fn(stubFetch({ [MANIFEST_URL]: { status: 404, body: utf8('') } }))
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => 0, resolve: PUBLIC_RESOLVER, updateCheckIntervalMs: 60_000 })

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('rejected')
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('rejected')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('checks every time when no interval is configured', async () => {
    const fetch = vi.fn(stubFetch(ROUTES))
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => 0, resolve: PUBLIC_RESOLVER })

    await loader.load(ORIGIN, NO_GRANTS)
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
  })
})

describe('createLoader: a declined capability is not asked about again', () => {
  const DECLARING = {
    [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } })) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
  }

  it('an unchanged bundle whose declared capability was never granted installs silently, instead of a capability prompt on every visit', async () => {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(DECLARING), storage, now: () => 0, resolve: PUBLIC_RESOLVER })
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')

    // The person declined at install, so the ledger holds nothing for it.
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
  })

  it('still prompts when the pinned manifest no longer hashes to its pin -- an unverified declaration suppresses nothing', async () => {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(DECLARING), storage, now: () => 0, resolve: PUBLIC_RESOLVER })
    await loader.load(ORIGIN, NO_GRANTS)
    await storage.writeAsset(ORIGIN, '/.well-known/orivon.json', utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['*:*'] } } } })))

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('needs-capability-prompt')
  })
})

// id.curves/fs.quotaBytes/net.concurrentSockets never turn into a Pattern
// (broker/policy/manifest-patterns.ts's own doc on widensInvisibleLimits),
// so decideUpdate's own PatternSet-based widening check cannot see one of
// them grow between the pinned manifest and a re-fetched one. Without the
// extra check decideAndRoute folds in, an update like this reads as a bare
// hash change -- 'needs-reconsent', whose dialog says permissions have not
// changed -- when the app just asked for something new.
describe('createLoader: a widened id/fs/net limit escalates past a bare reconsent', () => {
  it('a new id.curves entry, with the bundle otherwise changed, needs a capability prompt, not a reconsent', async () => {
    const v1 = { capabilities: { id: { curves: ['secp256k1'] } } }
    const v2 = { capabilities: { id: { curves: ['secp256k1', 'P-256'] } } }
    const storage = memoryStorage()
    expect((await createLoader({
      fetch: stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson(v1)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>v1') } }),
      storage, now: () => 0, resolve: PUBLIC_RESOLVER
    }).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')

    // A DIFFERENT body: without this, an unrelated defect (widening ignored
    // because the bundle hash didn't move either) could not be told apart
    // from the one this test actually targets.
    const result = await createLoader({
      fetch: stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson(v2)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>v2') } }),
      storage, now: () => 0, resolve: PUBLIC_RESOLVER
    }).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('needs-capability-prompt')
  })

  it('fs.quotaBytes growing alone, same bundle hash, still needs a capability prompt', async () => {
    const v1 = { capabilities: { fs: { quotaBytes: 1024 } } }
    const v2 = { capabilities: { fs: { quotaBytes: Number.MAX_SAFE_INTEGER } } }
    const ROUTES_V1 = { [MANIFEST_URL]: { body: utf8(manifestJson(v1)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') } }
    const ROUTES_V2 = { [MANIFEST_URL]: { body: utf8(manifestJson(v2)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') } }
    const storage = memoryStorage()
    expect((await createLoader({ fetch: stubFetch(ROUTES_V1), storage, now: () => 0, resolve: PUBLIC_RESOLVER }).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')

    const result = await createLoader({ fetch: stubFetch(ROUTES_V2), storage, now: () => 0, resolve: PUBLIC_RESOLVER }).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('needs-capability-prompt')
  })

  it('an unrelated bundle change with no limit widening still resolves the ordinary way (reconsent)', async () => {
    const manifest = { capabilities: { id: { curves: ['secp256k1'] } } }
    const storage = memoryStorage()
    expect((await createLoader({
      fetch: stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson(manifest)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>v1') } }),
      storage, now: () => 0, resolve: PUBLIC_RESOLVER
    }).load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')

    const result = await createLoader({
      fetch: stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson(manifest)) }, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>v2 -- same capabilities') } }),
      storage, now: () => 0, resolve: PUBLIC_RESOLVER
    }).load(ORIGIN, NO_GRANTS)
    expect(result.outcome).toBe('needs-reconsent')
  })
})
