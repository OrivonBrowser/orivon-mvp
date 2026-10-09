import { describe, expect, it, vi } from 'vitest'
import type { Fetch } from '../fetch/bundle.js'
import { createLoader } from '../index.js'
import { DDOC_PATH } from '../ddoc-declaration.js'
import { leafOf } from '../leaf-hash.js'
import { MANIFEST_PATH } from '../../broker/policy/canonical-path.js'
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
    [`${ORIGIN}${DDOC_PATH}`]: { status: 404, body: utf8('') },
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

  it('says serving could not be set up when onInstalled fails, though the bundle is pinned', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loader = loaderOver(stubFetch(routes()), async () => { throw new Error('protocol handler refused') })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    const installed = await loader.installFetched(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, fetched.content)
    expect(installed).toMatchObject({ outcome: 'installed', servingFailed: true })
    expect((await loader.pinFor(ORIGIN))?.bundleHash).toBe(fetched.tree.root)
    error.mockRestore()
  })

  it('does not say so when serving was set up', async () => {
    const loader = loaderOver(stubFetch(routes()), async () => {})
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    expect(await loader.installFetched(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, fetched.content)).not.toHaveProperty('servingFailed')
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

describe('Loader.readDeclaration', () => {
  const manifestBytes = utf8(manifestJson({ assets: ['app.js'] }))

  async function declaring (leaves: Record<string, string>): Promise<Record<string, RouteSpec>> {
    return routes({ [`${ORIGIN}${DDOC_PATH}`]: { body: utf8(JSON.stringify({ bundleHash: `sha256:${'a'.repeat(64)}`, leaves })) } })
  }

  async function readOf (fetch: Fetch): Promise<{ loader: ReturnType<typeof createLoader>, read: Extract<Awaited<ReturnType<ReturnType<typeof createLoader>['readManifest']>>, { kind: 'app' }> }> {
    const loader = loaderOver(fetch, undefined, true)
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    return { loader, read }
  }

  it('reads the declared tree and nothing else, from the root the manifest came from', async () => {
    const declared = { [MANIFEST_PATH]: await leafOf(MANIFEST_PATH, manifestBytes.length, [manifestBytes]) }
    const sent: Array<Record<string, string> | undefined> = []
    const { fetch, urls } = counting(stubFetch(await declaring(declared)))
    const { loader, read } = await readOf(async (url, addresses, signal, headers) => { sent.push(headers); return await fetch(url, addresses, signal, headers) })
    urls.length = 0
    sent.length = 0
    const result = await loader.readDeclaration(read)
    expect(result).toMatchObject({ kind: 'declared' })
    expect(result.kind === 'declared' && result.declaration.leaves).toEqual([{ path: MANIFEST_PATH, leaf: declared[MANIFEST_PATH] }])
    expect(urls).toEqual([`${ORIGIN}${DDOC_PATH}`])
    expect(sent[0]?.[ROOT]).toBe(CID)
  })

  it('says none for a site that publishes no tree: nothing to check its files against', async () => {
    const { loader, read } = await readOf(stubFetch(routes()))
    expect(await loader.readDeclaration(read)).toEqual({ kind: 'none' })
  })

  it('says it could not be read, after its attempts, for a host that fails: that is no permission to skip the check', async () => {
    vi.useFakeTimers()
    try {
      const { loader, read } = await readOf(stubFetch(routes({ [`${ORIGIN}${DDOC_PATH}`]: { status: 502, body: utf8('') } })))
      const pending = loader.readDeclaration(read)
      await vi.runAllTimersAsync()
      expect(await pending).toMatchObject({ kind: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the manifest differs when the tree gives it another leaf, and when it gives it none', async () => {
    const other = { [MANIFEST_PATH]: `sha256:${'c'.repeat(64)}` }
    const { loader, read } = await readOf(stubFetch(await declaring(other)))
    expect(await loader.readDeclaration(read)).toEqual({ kind: 'mismatch', differing: [MANIFEST_PATH] })
    const missing = await readOf(stubFetch(await declaring({ '/app.js': `sha256:${'d'.repeat(64)}` })))
    expect(await missing.loader.readDeclaration(missing.read)).toEqual({ kind: 'mismatch', differing: [MANIFEST_PATH] })
  })

  it('says the content is not what its address names when the verifier says so', async () => {
    const verified = `https://${CID}.ipfs.orivon`
    const fetch = stubFetch({
      [`${verified}/.well-known/orivon.json`]: { body: manifestBytes },
      [`${verified}${DDOC_PATH}`]: { status: 502, body: utf8(''), headers: { 'x-orivon-failure': 'unverifiable' } }
    })
    const loader = loaderOver(fetch, undefined, true)
    const read = await loader.readManifest(verified)
    if (read.kind !== 'app') throw new Error('expected an app')
    expect(await loader.readDeclaration(read)).toMatchObject({ kind: 'failed', integrity: true })
  })
})

describe('Loader.serveLive', () => {
  it('hands the shell what the page of an app needs to run before its files are pinned, and ends it on request', async () => {
    const served = vi.fn(async () => {})
    const ended = vi.fn(async () => {})
    const loader = createLoader({ fetch: stubFetch(routes()), storage: memoryStorage(), now: () => 1, resolve: PUBLIC_RESOLVER, contentAddress: async () => ({ cid: CID, via: 'ipns-key' as const, pointersVerified: true }), serveLive: served, endLive: ended })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    const hooks = { onBadData: vi.fn(), fresh: vi.fn(), adopt: vi.fn(), onServed: vi.fn() }
    expect(await loader.serveLive(read, undefined, hooks)).toBe(true)
    expect(served).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN, manifest: read.manifest, declaration: undefined, content: CID, ...hooks }))
    await loader.endLive(ORIGIN)
    expect(ended).toHaveBeenCalledWith(ORIGIN)
  })

  it('says nothing was set up in a run that has no way to', async () => {
    const loader = loaderOver(stubFetch(routes()))
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    expect(await loader.serveLive(read, undefined, { onBadData: () => {} })).toBe(false)
  })
})

describe('Loader.serveLive, for where the files come from', () => {
  it('gives an app on an ordinary site a way to fetch its own files from main, through the install guard, and an app a verifier serves none', async () => {
    const served = vi.fn(async (_bundle: unknown) => {})
    const seen: string[] = []
    const fetch: Fetch = async (url, ...rest) => { seen.push(url); return await stubFetch(routes())(url, ...rest) }
    const loader = createLoader({ fetch, storage: memoryStorage(), now: () => 1, resolve: PUBLIC_RESOLVER, serveLive: served })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    seen.length = 0
    await loader.serveLive(read, undefined, { onBadData: () => {} })
    const bundle = served.mock.calls[0]?.[0] as { fetchNetwork?: (url: string, init: { method: string, headers: Record<string, string>, signal: AbortSignal }) => Promise<{ status: number }> }
    const answered = await bundle.fetchNetwork?.(`${ORIGIN}/app.js`, { method: 'GET', headers: {}, signal: new AbortController().signal })
    expect(answered?.status).toBe(200)
    expect(seen).toEqual([`${ORIGIN}/app.js`])

    const verified = `https://${CID}.ipfs.orivon`
    const onVerifier = createLoader({ fetch: stubFetch({ [`${verified}/.well-known/orivon.json`]: { body: utf8(manifestJson({ assets: ['app.js'] })) } }), storage: memoryStorage(), now: () => 1, resolve: PUBLIC_RESOLVER, serveLive: served })
    const verifiedRead = await onVerifier.readManifest(verified)
    if (verifiedRead.kind !== 'app') throw new Error('expected an app')
    await onVerifier.serveLive(verifiedRead, undefined, { onBadData: () => {} })
    expect((served.mock.calls[1]?.[0] as { fetchNetwork?: unknown }).fetchNetwork).toBeUndefined()
  })
})

describe('the consent that outlives a restart', () => {
  const declaration = { bundleHash: `sha256:${'a'.repeat(64)}`, leaves: [{ path: '/index.html', leaf: `sha256:${'b'.repeat(64)}` }] }

  async function consented (): Promise<{ loader: ReturnType<typeof createLoader>, storage: ReturnType<typeof memoryStorage>, read: Extract<Awaited<ReturnType<ReturnType<typeof createLoader>['readManifest']>>, { kind: 'app' }> }> {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(routes()), storage, now: () => 1_700_000_000_000, resolve: PUBLIC_RESOLVER, contentAddress: async () => ({ cid: CID, via: 'ipns-key' as const, pointersVerified: true }) })
    const read = await loader.readManifest(ORIGIN)
    if (read.kind !== 'app') throw new Error('expected an app')
    return { loader, storage, read }
  }

  it('brings back the manifest, the root and the declared tree that were allowed, byte for byte', async () => {
    const { loader, read } = await consented()
    await loader.rememberConsent(read, declaration)
    const [again] = await loader.pendingConsents()
    expect(again?.read.canonicalOrigin).toBe(ORIGIN)
    expect(again?.read.manifest).toEqual(read.manifest)
    expect(Array.from(again?.read.bytes ?? [])).toEqual(Array.from(read.bytes))
    expect(again?.read.content).toEqual(read.content)
    expect(again?.declaration).toEqual(declaration)
  })

  it('remembers an app that declares no tree as one that does not', async () => {
    const { loader, read } = await consented()
    await loader.rememberConsent(read, undefined)
    expect((await loader.pendingConsents())[0]?.declaration).toBeUndefined()
  })

  it('is gone once the app is pinned, taken away, or cannot be read', async () => {
    const { loader, storage, read } = await consented()
    await loader.rememberConsent(read, declaration)
    const fetched = await loader.fetchForInstall(read, ORIGIN)
    if (!fetched.ok) throw new Error(fetched.reason)
    await loader.installFetched(fetched.canonicalOrigin, fetched.manifest, fetched.tree, fetched.entries, fetched.declaration, fetched.content)
    expect(await loader.pendingConsents()).toEqual([])
    expect(await storage.readPending(ORIGIN)).toBeUndefined()

    await loader.rememberConsent(read, declaration)
    await loader.endLive(ORIGIN)
    expect(await storage.readPending(ORIGIN)).toBeUndefined()

    await storage.writePending(ORIGIN, { schema: 1, origin: ORIGIN, manifestBytes: 'not a manifest' })
    expect(await loader.pendingConsents()).toEqual([])
    expect(await storage.readPending(ORIGIN)).toBeUndefined()
  })

  it('drops a record whose pin was written by another path before the consent was cleared', async () => {
    const { loader, storage, read } = await consented()
    await loader.rememberConsent(read, declaration)
    await storage.writePin(ORIGIN, { schema: 1, origin: ORIGIN, bundleHash: `sha256:${'c'.repeat(64)}`, assets: [{ path: '/.well-known/orivon.json', leaf: `sha256:${'d'.repeat(64)}` }], version: '1.0.0', pinnedAt: 0, content: { cid: CID, via: 'ipns-key', pointersVerified: true } })
    expect(await loader.pendingConsents()).toEqual([])
  })
})
