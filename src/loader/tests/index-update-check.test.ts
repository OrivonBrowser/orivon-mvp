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
    const fetch = vi.fn(stubFetch({}))
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
