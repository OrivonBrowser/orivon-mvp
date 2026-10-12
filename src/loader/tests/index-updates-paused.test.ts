import { describe, expect, it, vi } from 'vitest'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const ROUTES = {
  [MANIFEST_URL]: { body: utf8(manifestJson()) },
  [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
}

// An installed app whose traffic is routed is not checked for updates from this machine: the check would leave direct.
describe('createLoader: updatesPaused', () => {
  it('answers up-to-date for an installed app while its updates are paused, asking nothing, and checks again once they are not', async () => {
    let paused = false
    const fetch = vi.fn(stubFetch(ROUTES))
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => 0, resolve: PUBLIC_RESOLVER, updatesPaused: () => paused })
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    const fetched = fetch.mock.calls.length

    paused = true
    expect(await loader.load(`${ORIGIN}/deep/link`, NO_GRANTS)).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(await loader.load(ORIGIN, NO_GRANTS, { recheck: true })).toEqual({ outcome: 'up-to-date', canonicalOrigin: ORIGIN })
    expect(fetch.mock.calls.length).toBe(fetched)

    paused = false
    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(fetch.mock.calls.length).toBeGreaterThan(fetched)
  })

  it('does not hold back a first visit: an app that is not installed has nothing to pause', async () => {
    const fetch = vi.fn(stubFetch(ROUTES))
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => 0, resolve: PUBLIC_RESOLVER, updatesPaused: () => true })

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
  })
})
