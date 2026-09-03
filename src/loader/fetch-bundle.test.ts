import { describe, expect, it, vi } from 'vitest'
import { MAX_ASSET_BYTES } from '../broker/policy/bundle-hash.js'
import { MAX_BUNDLE_ENTRIES } from '../broker/policy/canonical-path.js'
import { fetchBundle } from './fetch-bundle.js'
import type { Fetch } from './fetch-bundle.js'
import { MANIFEST_URL, ORIGIN, manifestJson, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

describe('fetchBundle: happy path', () => {
  it('fetches the manifest and every declared asset, and pins the entry leaf', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
      [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/index.html', '/app.js'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.canonicalOrigin).toBe(ORIGIN)
    expect(result.manifest.id).toBe('app.orivon.example')
    expect(result.entries).toHaveLength(3)
    expect(result.tree.root).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.tree.assets.map((a) => a.path).sort()).toEqual([
      '/.well-known/orivon.json', '/app.js', '/index.html'
    ])
  })
})

describe('fetchBundle: origin and discovery', () => {
  it('rejects a hintedUrl that is not a valid origin', async () => {
    const result = await fetchBundle(stubFetch({}), 'not a url', [])
    expect(result.ok).toBe(false)
  })

  it('always fetches exactly <origin>/.well-known/orivon.json, ignoring a hinted path', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'a.html' })) },
      [`${ORIGIN}/a.html`]: { body: utf8('x') }
    }
    const result = await fetchBundle(stubFetch(routes), `${ORIGIN}/some/page.html`, ['/a.html'])
    expect(result.ok).toBe(true)
  })

  it('rejects when the manifest is actually served from a different origin than requested', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()), url: 'https://evil.example.com/.well-known/orivon.json' }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/origin/i)
  })

  it('rejects when the manifest response resolves to a path other than the well-known one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()), url: `${ORIGIN}/manifest-redirected.json` }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, [])
    expect(result.ok).toBe(false)
  })
})

describe('fetchBundle: manifest fetch and validation failures', () => {
  it('rejects a network failure fetching the manifest', async () => {
    const failing: Fetch = async () => { throw new Error('DNS failure') }
    const result = await fetchBundle(failing, ORIGIN, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/DNS failure/)
  })

  it('rejects a non-ok HTTP status fetching the manifest', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { status: 404, body: utf8('') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/404/)
  })

  it('surfaces parseManifest\'s own rejection reason for malformed JSON', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8('{not json') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid JSON/)
  })
})

describe('fetchBundle: Manifest.entry must have a leaf (ADR-0009 amendment #2)', () => {
  it('rejects a bundle with no leaf at the manifest\'s declared entry point', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'index.html' })) },
      [`${ORIGIN}/other.js`]: { body: utf8('x') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/other.js'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/entry/i)
  })
})

describe('fetchBundle: byte and entry caps enforced before holding the whole bundle', () => {
  it('rejects immediately, before any fetch, when the entry count would exceed MAX_BUNDLE_ENTRIES', async () => {
    const spy = vi.fn(async () => { throw new Error('should never be called') })
    const tooMany = Array.from({ length: MAX_BUNDLE_ENTRIES }, (_, i) => `/a${String(i)}.js`)
    const result = await fetchBundle(spy as unknown as Fetch, ORIGIN, tooMany)
    expect(result.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an asset whose actual bytes exceed MAX_ASSET_BYTES', async () => {
    const oversized = new Uint8Array(MAX_ASSET_BYTES + 1)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: oversized }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/index.html'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })

  it('fails fast on a declared Content-Length over MAX_ASSET_BYTES -- never reads the body', async () => {
    const bodyReads = new Set<string>()
    const assetUrl = `${ORIGIN}/huge.bin`
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [assetUrl]: { body: utf8('tiny'), headers: { 'content-length': String(MAX_ASSET_BYTES + 1) } }
    }
    const result = await fetchBundle(stubFetch(routes, bodyReads), ORIGIN, ['/huge.bin'])
    expect(result.ok).toBe(false)
    expect(bodyReads.has(assetUrl)).toBe(false)
  })

  it('stops fetching further assets once the running total exceeds MAX_BUNDLE_BYTES', async () => {
    // The running total is tracked from ACTUAL downloaded bytes, never a
    // declared Content-Length (a declared value is only ever used to fail
    // fast on ONE oversized response, never accumulated -- see
    // fetchWithBudget's own comment). So this test needs real bytes: five
    // 14 MiB assets, each comfortably under MAX_ASSET_BYTES (16 MiB) on its
    // own, whose sum (70 MiB) crosses MAX_BUNDLE_BYTES (64 MiB) partway
    // through. A 6th must never be requested at all once that happens.
    const perAsset = 14 * 1024 * 1024
    const paths = ['/a0.bin', '/a1.bin', '/a2.bin', '/a3.bin', '/a4.bin', '/a5.bin']
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson()) } }
    for (const path of paths) {
      routes[`${ORIGIN}${path}`] = { body: new Uint8Array(perAsset) }
    }
    const requested: string[] = []
    const fetchFn: Fetch = async (url) => {
      requested.push(url)
      return await stubFetch(routes)(url)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, paths)
    expect(result.ok).toBe(false)
    // 4 assets * 14 MiB = 56 MiB, still under the cap; the 5th (index a4)
    // only has 8 MiB of budget left and tips it over, so a5 must never be
    // requested.
    expect(requested).not.toContain(`${ORIGIN}/a5.bin`)
  })
})

describe('fetchBundle: delegates structural rejection to bundleTree', () => {
  it('rejects two assets that collide under case-folding', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/App.js`]: { body: utf8('a') },
      [`${ORIGIN}/app.js`]: { body: utf8('b') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/App.js', '/app.js'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/collide/)
  })
})
