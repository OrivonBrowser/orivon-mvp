import { afterEach, describe, expect, it, vi } from 'vitest'
import { ddocVerdict } from '../../trust/ddoc.js'
import { DDOC_PATH } from '../ddoc-declaration.js'
import { fetchBundle } from '../fetch/bundle.js'
import { createLoader } from '../index.js'
import type { LoadContext } from '../index.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { MemoryStorage, RouteSpec } from './test-helpers.js'

// ADR-0029: what an install stores of the tree a site publishes, and why a
// stale one can never read as verified against a newer pin.

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
const DDOC_URL = `${ORIGIN}${DDOC_PATH}`

function routesFor (html: string): Record<string, RouteSpec> {
  return {
    [MANIFEST_URL]: { body: utf8(manifestJson()) },
    [`${ORIGIN}/index.html`]: { body: utf8(html) }
  }
}

/** Routes for `html` that also publish its honest tree, computed by the loader itself. */
async function publishedRoutesFor (html: string): Promise<Record<string, RouteSpec>> {
  const routes = routesFor(html)
  const fetched = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
  if (!fetched.ok) throw new Error(fetched.reason)
  const leaves = Object.fromEntries(fetched.tree.assets.map((a) => [a.path, a.leaf]))
  return { ...routes, [DDOC_URL]: { body: utf8(JSON.stringify({ bundleHash: fetched.tree.root, leaves })) } }
}

function loaderOver (storage: MemoryStorage, routes: Record<string, RouteSpec>): ReturnType<typeof createLoader> {
  return createLoader({ fetch: stubFetch(routes), storage, now: () => 1_700_000_000_000, resolve: PUBLIC_RESOLVER })
}

async function verdictFor (loader: ReturnType<typeof createLoader>): Promise<ReturnType<typeof ddocVerdict>> {
  return ddocVerdict(await loader.pinFor(ORIGIN), await loader.ddocFor(ORIGIN))
}

afterEach(() => { vi.restoreAllMocks() })

describe('createLoader: the published DDOC hash tree is stored beside the pin', () => {
  it('a fresh install stores it, and it verifies against the pin', async () => {
    const storage = memoryStorage()
    const loader = loaderOver(storage, await publishedRoutesFor('<!doctype html>v1'))

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(await verdictFor(loader)).toEqual({ status: 'verified' })
  })

  it('a site that publishes nothing installs, and reads as not published', async () => {
    const loader = loaderOver(memoryStorage(), routesFor('<!doctype html>v1'))

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(await verdictFor(loader)).toEqual({ status: 'not-published' })
  })

  it('an unchanged bundle picks up a tree the site has started publishing since', async () => {
    const storage = memoryStorage()
    await loaderOver(storage, routesFor('<!doctype html>v1')).load(ORIGIN, NO_GRANTS)
    const loader = loaderOver(storage, await publishedRoutesFor('<!doctype html>v1'))

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(await verdictFor(loader)).toEqual({ status: 'verified' })
  })

  it('an approved update that publishes nothing removes the old tree', async () => {
    const storage = memoryStorage()
    await loaderOver(storage, await publishedRoutesFor('<!doctype html>v1')).load(ORIGIN, NO_GRANTS)
    const loader = loaderOver(storage, routesFor('<!doctype html>v2'))

    const pending = await loader.load(ORIGIN, NO_GRANTS)
    expect(pending.outcome).toBe('needs-reconsent')
    if (pending.outcome !== 'needs-reconsent') return
    await loader.installFetched(ORIGIN, pending.manifest, pending.tree, pending.entries, pending.declaration, undefined)

    expect(await loader.ddocFor(ORIGIN)).toBeUndefined()
    expect(await verdictFor(loader)).toEqual({ status: 'not-published' })
  })

  it('a tree that does not match the files installs anyway, and reads as failed', async () => {
    const routes = await publishedRoutesFor('<!doctype html>v1')
    routes[`${ORIGIN}/index.html`] = { body: utf8('<!doctype html>tampered') }
    const loader = loaderOver(memoryStorage(), routes)

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    const verdict = await verdictFor(loader)
    expect(verdict.status).toBe('failed')
    if (verdict.status === 'failed') expect(verdict.differing).toEqual(['/index.html'])
  })

  // The old tree goes before the new pin is written: a crash between the
  // two must leave "not published", never the old tree failing the new pin.
  it('an install that dies writing the pin leaves no tree behind', async () => {
    const storage = memoryStorage()
    await loaderOver(storage, await publishedRoutesFor('<!doctype html>v1')).load(ORIGIN, NO_GRANTS)
    const loader = loaderOver(storage, await publishedRoutesFor('<!doctype html>v2'))
    const pending = await loader.load(ORIGIN, NO_GRANTS)
    if (pending.outcome !== 'needs-reconsent') throw new Error(pending.outcome)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(storage.writePin).mockRejectedValueOnce(new Error('disk full'))
    const result = await loader.installFetched(ORIGIN, pending.manifest, pending.tree, pending.entries, pending.declaration, undefined)

    expect(result.outcome).toBe('rejected')
    expect(await loader.ddocFor(ORIGIN)).toBeUndefined()
  })

  it('failing to store the tree never fails the install that carried it', async () => {
    const storage = memoryStorage()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(storage.writeDdoc).mockRejectedValue(new Error('disk full'))
    const loader = loaderOver(storage, await publishedRoutesFor('<!doctype html>v1'))

    expect((await loader.load(ORIGIN, NO_GRANTS)).outcome).toBe('installed')
    expect(storage.pins.has(ORIGIN)).toBe(true)
  })
})
