// What a first visit needs to tell apart in a failed fetch (ADR-0074): a size cap, an integrity failure the verifier proved, a
// declaration that could not be downloaded, and a tab that left. Everything else is a plain failure.

import { describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../../../broker/policy/bundle-hash.js'
import { DDOC_PATH } from '../../ddoc-declaration.js'
import { fetchBundle } from '../bundle.js'
import type { Fetch } from '../bundle.js'
import { FAILURE_HEADER } from '../content-root.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'
import type { RouteSpec } from '../../tests/test-helpers.js'

const FAST = { retryBackoffMs: [1, 1] }
const APP_JS = `${ORIGIN}/app.js`
const DDOC_URL = `${ORIGIN}${DDOC_PATH}`

function routes (extra: Record<string, RouteSpec> = {}): Record<string, RouteSpec> {
  return {
    [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
    [APP_JS]: { body: utf8('console.log(1)') },
    [DDOC_URL]: { status: 404, body: utf8('') },
    ...extra
  }
}

describe('fetchBundle: what kind of failure it was', () => {
  it('marks a file over its cap, and a bundle over its budget, as too large', async () => {
    const over = await fetchBundle(stubFetch(routes({ [APP_JS]: { body: utf8('x'.repeat(5000)) } })), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: 50, bundleBytes: MAX_BUNDLE_BYTES, ...FAST })
    expect(over).toMatchObject({ ok: false, tooLarge: true })
    const budget = await fetchBundle(stubFetch(routes({ [APP_JS]: { body: utf8('x'.repeat(5000)) } })), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: 1000, ...FAST })
    expect(budget).toMatchObject({ ok: false, tooLarge: true })
  })

  it('marks a 502 the verifier says is a failed verification as an integrity failure, and does not retry it', async () => {
    let asked = 0
    const real = stubFetch(routes())
    const fetchFn: Fetch = async (url, pinned, signal, headers) => {
      if (url !== APP_JS) return await real(url, pinned, signal, headers)
      asked += 1
      return { ok: false, status: 502, url, headers: { get: (name) => name === FAILURE_HEADER ? 'unverifiable' : null }, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, ...FAST })
    expect(result).toMatchObject({ ok: false, integrity: true })
    expect(result).not.toHaveProperty('transient')
    expect(asked).toBe(1)
  })

  it('records the status that refused a request', async () => {
    const result = await fetchBundle(stubFetch(routes({ [APP_JS]: { status: 403, body: utf8('') } })), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, ...FAST })
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(result).not.toMatchObject({ tooLarge: true })
    expect(result).not.toMatchObject({ integrity: true })
  })
})

describe('fetchBundle: a declaration that cannot be downloaded, when the caller must judge it', () => {
  const strict = { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, strictDeclaration: true, ...FAST }

  it('is a failed download, never "not published", for a timeout, a network error or a 5xx', async () => {
    for (const spec of [{ status: 502, body: utf8('') }, { status: 500, body: utf8('') }, { status: 403, body: utf8('') }] satisfies RouteSpec[]) {
      const result = await fetchBundle(stubFetch(routes({ [DDOC_URL]: spec })), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)
      expect(result, JSON.stringify(spec)).toMatchObject({ ok: false })
    }
    const down: Fetch = async (url, pinned, signal, headers) => {
      if (url === DDOC_URL) throw new TypeError('fetch failed')
      return await stubFetch(routes())(url, pinned, signal, headers)
    }
    expect(await fetchBundle(down, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)).toMatchObject({ ok: false, transient: true })
  })

  it('is retried like any other file', async () => {
    let asked = 0
    const real = stubFetch(routes())
    const flaky: Fetch = async (url, pinned, signal, headers) => {
      if (url === DDOC_URL && (asked += 1) === 1) return { ok: false, status: 502, url, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
      return await real(url, pinned, signal, headers)
    }
    expect((await fetchBundle(flaky, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)).ok).toBe(true)
    expect(asked).toBe(2)
  })

  it('is "not published" for a 404, and for a body that is no declaration', async () => {
    expect((await fetchBundle(stubFetch(routes()), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)).ok).toBe(true)
    const html = await fetchBundle(stubFetch(routes({ [DDOC_URL]: { body: utf8('<!doctype html><p>index') } })), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)
    expect(html.ok && html.declaration).toBeUndefined()
  })

  it('is fetched before any file of the bundle', async () => {
    const order: string[] = []
    const real = stubFetch(routes())
    const watching: Fetch = async (url, pinned, signal, headers) => { order.push(url); return await real(url, pinned, signal, headers) }
    await fetchBundle(watching, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), strict)
    expect(order.indexOf(DDOC_URL)).toBeLessThan(order.indexOf(APP_JS))
    expect(order.indexOf(DDOC_URL)).toBeLessThan(order.indexOf(`${ORIGIN}/index.html`))
  })

  it('stays "not published" for the ordinary install path, which never judges it', async () => {
    const down: Fetch = async (url, pinned, signal, headers) => {
      if (url === DDOC_URL) throw new TypeError('fetch failed')
      return await stubFetch(routes())(url, pinned, signal, headers)
    }
    expect((await fetchBundle(down, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, ...FAST })).ok).toBe(true)
  })
})

describe('fetchBundle: a caller that leaves', () => {
  it('stops downloading and fails when the caller\'s signal aborts', async () => {
    const controller = new AbortController()
    const real = stubFetch(routes())
    const fetchFn: Fetch = async (url, pinned, signal, headers) => {
      if (url === APP_JS) controller.abort()
      return await real(url, pinned, signal, headers)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, signal: controller.signal, ...FAST })
    expect(result.ok).toBe(false)
  })

  it('does not start at all when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let asked = 0
    const counting: Fetch = async (...args) => { asked += 1; return await stubFetch(routes())(...args) }
    const result = await fetchBundle(counting, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, signal: controller.signal, ...FAST })
    expect(result.ok).toBe(false)
    expect(asked).toBe(0)
  })
})
