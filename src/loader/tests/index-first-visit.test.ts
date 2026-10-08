import { describe, expect, it, vi } from 'vitest'
import type { Fetch } from '../fetch/bundle.js'
import { createLoader } from '../index.js'
import { DDOC_PATH } from '../ddoc-declaration.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

// The two halves of a first visit: the manifest alone, so the person is asked before any file is
// downloaded, and then the whole bundle, held in staging until the caller decides to install it.

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const ROOT = 'x-orivon-content-root'

function routes (overrides: Record<string, RouteSpec> = {}): Record<string, RouteSpec> {
  return {
    [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') },
    [`${ORIGIN}/app.js`]: { body: utf8('run()') },
    ...overrides
  }
}

function counting (inner: Fetch): { fetch: Fetch, urls: string[] } {
  const urls: string[] = []
  return { fetch: async (url, ...rest) => { urls.push(url); return await inner(url, ...rest) }, urls }
}

function loaderOver (fetch: Fetch, onInstalled?: (origin: string) => Promise<void>, content = false): ReturnType<typeof createLoader> {
  const storage = memoryStorage()
  return createLoader({
    fetch,
    storage,
    now: () => 1_700_000_000_000,
    resolve: PUBLIC_RESOLVER,
    ...(onInstalled === undefined ? {} : { onInstalled }),
    ...(content ? { contentAddress: async () => ({ cid: CID, via: 'ipns-key' as const, pointersVerified: true }) } : {})
  })
}

describe('Loader.readManifest', () => {
  it('reads the manifest and nothing else of the bundle', async () => {
    const { fetch, urls } = counting(stubFetch(routes()))
    const loader = loaderOver(fetch)
    const read = await loader.readManifest(ORIGIN)
    expect(read).toMatchObject({ kind: 'app', canonicalOrigin: ORIGIN, content: undefined })
    expect(read.kind === 'app' && read.manifest.name).toBe('Example App')
    expect(urls).toEqual([MANIFEST_URL])
    expect(await loader.pinFor(ORIGIN)).toBeNull()
  })

  it('reads through the root a name leads to, and remembers a verified absence', async () => {
    const { fetch, urls } = counting(stubFetch(routes({ [MANIFEST_URL]: { status: 404, body: utf8(''), headers: { [ROOT]: CID } } })))
    const loader = loaderOver(fetch, undefined, true)
    expect(await loader.readManifest(ORIGIN)).toEqual({ kind: 'website' })
    expect(await loader.readManifest(ORIGIN)).toEqual({ kind: 'website' })
    expect(urls).toHaveLength(1)
  })

  it('says unread for a host that failed, and for an address that is no origin', async () => {
    const failing = loaderOver(stubFetch(routes({ [MANIFEST_URL]: { status: 502, body: utf8('') } })))
    expect(await failing.readManifest(ORIGIN)).toMatchObject({ kind: 'unread' })
    expect(await failing.readManifest('not a url')).toMatchObject({ kind: 'unread' })
  })

  it('reads a 404 from a host with no content root as unread: an ordinary site proves nothing by it', async () => {
    const loader = loaderOver(stubFetch(routes({ [MANIFEST_URL]: { status: 404, body: utf8('') } })))
    expect(await loader.readManifest(ORIGIN)).toMatchObject({ kind: 'unread' })
  })
})

describe('Loader.fetchForInstall', () => {
  it('downloads every file and installs nothing', async () => {
    const onInstalled = vi.fn(async () => {})
    const { fetch, urls } = counting(stubFetch(routes()))
    const loader = loaderOver(fetch, onInstalled)
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    expect(urls.sort()).toEqual([MANIFEST_URL, MANIFEST_URL, `${ORIGIN}${DDOC_PATH}`, `${ORIGIN}/app.js`, `${ORIGIN}/index.html`].sort())
    expect(fetched.tree.assets.map((asset) => asset.path).sort()).toEqual(['/.well-known/orivon.json', '/app.js', '/index.html'])
    expect(fetched.declaration).toBeUndefined()
    expect(await loader.pinFor(ORIGIN)).toBeNull()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('installs what it fetched when asked, and discard leaves nothing staged', async () => {
    const onInstalled = vi.fn(async () => {})
    const loader = loaderOver(stubFetch(routes()), onInstalled)
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    const installed = await loader.installFetched(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, fetched.content)
    expect(installed.outcome).toBe('installed')
    expect(onInstalled).toHaveBeenCalledWith(ORIGIN)
    expect((await loader.pinFor(ORIGIN))?.bundleHash).toBe(fetched.tree.root)
  })

  it('discard clears what a bundle left in staging', async () => {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(routes()), storage, now: () => 1, resolve: PUBLIC_RESOLVER })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    expect(storage.staged.size).toBeGreaterThan(0)
    await fetched.discard()
    expect(storage.staged.size).toBe(0)
  })

  it('fails, with nothing left staged, when a declared file cannot be downloaded', async () => {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(routes({ [`${ORIGIN}/app.js`]: { status: 404, body: utf8('') } })), storage, now: () => 1, resolve: PUBLIC_RESOLVER })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    expect(fetched.ok).toBe(false)
    expect(storage.staged.size).toBe(0)
  })

  it('says a download failed for good only when the bundle itself is bad: a 404 is, a gateway\'s 502 that outlasts its attempts is not', async () => {
    vi.useFakeTimers()
    try {
      const bad = loaderOver(stubFetch(routes({ [`${ORIGIN}/app.js`]: { status: 404, body: utf8('') } })))
      const badRead = await bad.readManifest(ORIGIN)
      if (badRead.kind !== 'app') throw new Error('expected an app')
      const badFetch = await bad.fetchForInstall(badRead, ORIGIN)
      expect(badFetch).toMatchObject({ ok: false })
      expect(!badFetch.ok && badFetch.transient).toBeUndefined()

      const unwell = loaderOver(stubFetch(routes({ [`${ORIGIN}/app.js`]: { status: 502, body: utf8('') } })))
      const read = await unwell.readManifest(ORIGIN)
      if (read.kind !== 'app') throw new Error('expected an app')
      const pending = unwell.fetchForInstall(read, ORIGIN)
      await vi.runAllTimersAsync()
      const fetched = await pending
      expect(!fetched.ok && fetched.transient).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a bundle whose manifest is not the one the person was asked about', async () => {
    let served = manifestJson({ assets: ['app.js'], capabilities: {} })
    const changing: Fetch = async (url, ...rest) => await stubFetch(routes({ [MANIFEST_URL]: { body: utf8(served) } }))(url, ...rest)
    const loader = loaderOver(changing)
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    served = manifestJson({ assets: ['app.js'], capabilities: { fs: { quotaBytes: 1024 } }, version: '1.0.1' })
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    expect(fetched).toMatchObject({ ok: false })
    expect(!fetched.ok && fetched.reason).toMatch(/changed/)
    expect(!fetched.ok && fetched.transient).toBe(true)
  })

  it('carries the tree the site publishes', async () => {
    const declared = { bundleHash: `sha256:${'a'.repeat(64)}`, leaves: { '/index.html': `sha256:${'b'.repeat(64)}` } }
    const loader = loaderOver(stubFetch(routes({ [`${ORIGIN}${DDOC_PATH}`]: { body: utf8(JSON.stringify(declared)) } })))
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    expect(fetched.ok && fetched.declaration?.bundleHash).toBe(`sha256:${'a'.repeat(64)}`)
  })
})
