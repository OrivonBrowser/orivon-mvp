import { describe, expect, it } from 'vitest'
import type { Fetch } from '../fetch/bundle.js'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'

// The two manifest reads a trust decision uses: the pinned one, and the one a
// root CID names, which is read once per (origin, CID) and never cached when
// it failed.

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const OTHER_CID = 'bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4'
const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }

function counting (inner: Fetch): { fetch: Fetch, count: () => number } {
  let n = 0
  return { fetch: async (...args) => { n += 1; return await inner(...args) }, count: () => n }
}

function loaderOver (fetch: Fetch, storage = memoryStorage()): ReturnType<typeof createLoader> {
  return createLoader({ fetch, storage, now: () => 1_700_000_000_000, resolve: PUBLIC_RESOLVER })
}

describe('Loader.manifestAt', () => {
  it('asks once per (origin, CID) and answers the second call from memory', async () => {
    const { fetch, count } = counting(stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson({ domain: 'app.example.com' })) } }))
    const loader = loaderOver(fetch)
    expect(await loader.manifestAt(ORIGIN, CID)).toMatchObject({ kind: 'app' })
    expect(await loader.manifestAt(ORIGIN, CID)).toMatchObject({ kind: 'app' })
    expect(count()).toBe(1)
    await loader.manifestAt(ORIGIN, OTHER_CID)
    expect(count()).toBe(2)
  })

  it('remembers a verified absence', async () => {
    const { fetch, count } = counting(stubFetch({ [MANIFEST_URL]: { status: 404, body: utf8(''), headers: { 'x-orivon-content-root': CID } } }))
    const loader = loaderOver(fetch)
    expect(await loader.manifestAt(ORIGIN, CID)).toEqual({ kind: 'website' })
    await loader.manifestAt(ORIGIN, CID)
    expect(count()).toBe(1)
  })

  it('asks again after a failed read', async () => {
    const { fetch, count } = counting(stubFetch({ [MANIFEST_URL]: { status: 502, body: utf8('') } }))
    const loader = loaderOver(fetch)
    expect(await loader.manifestAt(ORIGIN, CID)).toMatchObject({ kind: 'unread' })
    await loader.manifestAt(ORIGIN, CID)
    expect(count()).toBe(2)
  })
})

describe('Loader.manifestFor', () => {
  it('reads the manifest the pin holds, and nothing over the network', async () => {
    const storage = memoryStorage()
    const plain = loaderOver(stubFetch({
      [MANIFEST_URL]: { body: utf8(manifestJson({ domain: 'app.example.com' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }), storage)
    expect((await plain.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    const { fetch, count } = counting(stubFetch({}))
    expect((await loaderOver(fetch, storage).manifestFor(ORIGIN))?.domain).toBe('app.example.com')
    expect(count()).toBe(0)
  })

  it('is undefined for an origin that was never pinned', async () => {
    expect(await loaderOver(stubFetch({})).manifestFor(ORIGIN)).toBeUndefined()
  })
})
