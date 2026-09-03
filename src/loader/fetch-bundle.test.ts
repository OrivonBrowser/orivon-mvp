import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../broker/policy/bundle-hash.js'
import { MAX_BUNDLE_ENTRIES } from '../broker/policy/canonical-path.js'
import { BUNDLE_TIMEOUT_MS, FETCH_TIMEOUT_MS, fetchBundle } from './fetch-bundle.js'
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
    const fetchFn: Fetch = async (url, signal) => {
      requested.push(url)
      return await stubFetch(routes)(url, signal)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, paths)
    expect(result.ok).toBe(false)
    // 4 assets * 14 MiB = 56 MiB, still under the cap; the 5th (index a4)
    // only has 8 MiB of budget left and tips it over, so a5 must never be
    // requested.
    expect(requested).not.toContain(`${ORIGIN}/a5.bin`)
  })
})

describe('fetchBundle: the actual byte cap is enforced while streaming, not after buffering the body (T11b)', () => {
  it('rejects a body with no Content-Length that exceeds MAX_ASSET_BYTES, without ever reading the whole thing', async () => {
    // No Content-Length AND no end to the body -- the only thing that can
    // stop this download is the incremental check inside the body-read loop
    // itself. `streamed` proves it actually stopped early: an unbounded
    // source, but only ever a few chunks over the cap were pulled.
    const assetUrl = `${ORIGIN}/huge.bin`
    const streamed = new Map<string, number>()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [assetUrl]: { body: new Uint8Array(0), infinite: true }
    }
    const result = await fetchBundle(stubFetch(routes, undefined, streamed), ORIGIN, ['/huge.bin'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
    const bytesRead = streamed.get(assetUrl) ?? 0
    expect(bytesRead).toBeGreaterThan(MAX_ASSET_BYTES)
    // Bounded near the cap: at most one chunk of slack, nowhere close to
    // "kept reading" -- the old bug read this same source until memory ran
    // out or the process died, which this bound rules out.
    expect(bytesRead).toBeLessThan(MAX_ASSET_BYTES + 64 * 1024 * 2)
  })

  it('rejects on actual bytes when Content-Length declares small but the body is large', async () => {
    const assetUrl = `${ORIGIN}/lying.bin`
    const oversized = new Uint8Array(MAX_ASSET_BYTES + 1024)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [assetUrl]: { body: oversized, headers: { 'content-length': '10' } }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/lying.bin'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })

  it('accepts a body whose actual size is exactly MAX_ASSET_BYTES -- no off-by-one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: new Uint8Array(MAX_ASSET_BYTES) }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/index.html'])
    expect(result.ok).toBe(true)
  })

  it('still enforces the cumulative MAX_BUNDLE_BYTES budget across several under-cap assets', async () => {
    // Same scenario the pre-existing suite above already covers end-to-end
    // (a 6th asset must never be requested once the running total tips the
    // budget); restated here beside the streaming tests as the third caller
    // this fix's brief names explicitly.
    const perAsset = 14 * 1024 * 1024
    const paths = ['/a0.bin', '/a1.bin', '/a2.bin', '/a3.bin', '/a4.bin', '/a5.bin']
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson()) } }
    for (const path of paths) routes[`${ORIGIN}${path}`] = { body: new Uint8Array(perAsset) }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, paths)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_BUNDLE_BYTES/)
    expect(perAsset * 5).toBeGreaterThan(MAX_BUNDLE_BYTES)
  })

  it('still rejects a single stream chunk that on its own is far larger than MAX_ASSET_BYTES', async () => {
    // The incremental cap in readBodyWithBudget is only as fine-grained as
    // the chunks the stream hands back -- it compares the RUNNING TOTAL
    // against the cap after each `read()`, so it can only refuse a chunk
    // once that chunk already exists. This proves the rejection still
    // fires correctly even when the whole asset arrives as one oversized
    // chunk (a decompressing fetch, a naive shim that buffers then emits
    // once, or a real undici under a gzip bomb could all produce exactly
    // this shape) -- see readBodyWithBudget's own comment for the residual
    // limit this does NOT close: that one chunk is still allocated in full
    // before the rejection can fire.
    const size = MAX_ASSET_BYTES + 5 * 1024 * 1024
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: new Uint8Array(size), chunkSize: size }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, ['/index.html'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })
})

describe('fetchBundle: a stalled fetch or body cannot stall the install forever', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('aborts a fetchFn call that never resolves', async () => {
    const stalls: Fetch = async () => await new Promise<never>(() => {})
    const pending = fetchBundle(stalls, ORIGIN, [])
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/timed out/i)
  })

  it('aborts a body read that never completes', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: new Uint8Array(0), stall: true }
    }
    const pending = fetchBundle(stubFetch(routes), ORIGIN, [])
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/timed out/i)
  })
})

describe('fetchBundle: a bundle-wide deadline bounds the whole install, not just one asset', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('rejects once cumulative time across many just-under-FETCH_TIMEOUT_MS assets exceeds BUNDLE_TIMEOUT_MS, cutting off the asset in flight and never starting the next one', async () => {
    // Models a hostile origin that evades FETCH_TIMEOUT_MS on every single
    // request (each asset resolves in FETCH_TIMEOUT_MS - 1ms, so no
    // per-asset timer ever fires) while still exhausting the install's
    // total wall-clock budget -- the T11b duration-axis DoS BUNDLE_TIMEOUT_MS
    // exists to close. BUNDLE_TIMEOUT_MS is 30 * FETCH_TIMEOUT_MS, so the
    // 31st such asset (index 30) is where the cumulative total
    // (30 * 19999ms = 599970ms) tips past the 600000ms deadline -- 30ms
    // into that asset's own fetch, proving the deadline can cut off a
    // request already in flight, not only refuse to start the next one.
    const perAssetDelay = FETCH_TIMEOUT_MS - 1
    const assetCount = 32
    const paths = Array.from({ length: assetCount }, (_, i) => `/a${String(i)}.js`)
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'a0.js' })) } }
    for (const path of paths) routes[`${ORIGIN}${path}`] = { body: utf8('x') }

    const requested: string[] = []
    const fetchFn: Fetch = async (url, signal) => {
      requested.push(url)
      if (url !== MANIFEST_URL) await new Promise<void>((resolve) => setTimeout(resolve, perAssetDelay))
      return await stubFetch(routes)(url, signal)
    }

    const pending = fetchBundle(fetchFn, ORIGIN, paths)
    await vi.advanceTimersByTimeAsync(assetCount * FETCH_TIMEOUT_MS)
    const result = await pending

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/overall deadline/i)
    expect(result.reason).toMatch(String(BUNDLE_TIMEOUT_MS))
    // The 30th asset (index 29) is the last one to finish cleanly; the
    // 31st (index 30) is cut off mid-flight (still requested, never
    // completes); the 32nd (index 31) must never be requested at all.
    expect(requested).toContain(`${ORIGIN}/a29.js`)
    expect(requested).toContain(`${ORIGIN}/a30.js`)
    expect(requested).not.toContain(`${ORIGIN}/a31.js`)
  })
})

describe('fetchBundle: an asset URL is origin-checked before it is ever fetched', () => {
  it('rejects an absolute cross-origin assetPath without fetching it', async () => {
    const attackerUrl = 'https://attacker.example/x'
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson()) } }
    const requested: string[] = []
    const fetchFn: Fetch = async (url, signal) => {
      requested.push(url)
      return await stubFetch(routes)(url, signal)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, [attackerUrl])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/origin/i)
    expect(requested).not.toContain(attackerUrl)
    expect(requested).toContain(MANIFEST_URL)
  })
})

describe('fetchBundle: a malformed assetPath is rejected, never thrown', () => {
  it('rejects an assetPath that new URL() cannot parse, instead of throwing', async () => {
    // `new URL('http://[not-valid-ipv6/x.js', base)` throws TypeError:
    // Invalid URL -- confirmed live against this runtime. assetPaths is
    // trusted developer input today, but A45 records that the real caller
    // does not exist yet and will plausibly derive it by crawling
    // server-supplied HTML, at which point this is remotely triggerable.
    const malformed = 'http://[not-valid-ipv6/x.js'
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson()) } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, [malformed])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not a valid url/i)
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
