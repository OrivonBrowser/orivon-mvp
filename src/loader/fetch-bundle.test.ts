import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../broker/policy/bundle-hash.js'
import { MAX_ANSWERS } from '../broker/policy/connect.js'
import type { Resolver } from '../broker/policy/connect.js'
import { BUNDLE_TIMEOUT_MS, FETCH_TIMEOUT_MS, fetchBundle } from './fetch-bundle.js'
import type { Fetch } from './fetch-bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

describe('fetchBundle: happy path', () => {
  it('fetches the manifest, the entry, and every manifest-declared asset, and pins the entry leaf', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
      [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
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

  it('fetches the entry even when the manifest declares no assets at all', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(true)
  })
})

describe('fetchBundle: origin and discovery', () => {
  it('rejects a hintedUrl that is not a valid origin', async () => {
    const result = await fetchBundle(stubFetch({}), 'not a url', PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
  })

  it('always fetches exactly <origin>/.well-known/orivon.json, ignoring a hinted path', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'a.html' })) },
      [`${ORIGIN}/a.html`]: { body: utf8('x') }
    }
    const result = await fetchBundle(stubFetch(routes), `${ORIGIN}/some/page.html`, PUBLIC_RESOLVER)
    expect(result.ok).toBe(true)
  })
})

// T12/A46: the install origin's hostname must resolve (or, for a literal,
// classify) as public-unicast before ANY network request happens -- this is
// the shell itself, unsandboxed, issuing the very first request that
// discovers whether an origin is an Orivon app at all, and it needs no grant
// and no manifest to reach here. Mirrors src/broker/policy/connect.ts's own
// "resolve once, validate every answer" discipline exactly, reusing
// classifyAddress/isPublicUnicast rather than a second implementation.
describe('fetchBundle: the install origin must resolve to a public-unicast address (T12/A46)', () => {
  // Every route below is a COMPLETE, otherwise-valid bundle -- if the guard
  // did not exist, every one of these would fetch successfully. That is
  // deliberate: a route table with a gap in it would make `result.ok`
  // false for the wrong reason (a missing fixture), passing this test
  // whether or not the guard actually runs. The `fetchFn`/`resolveFn` spy
  // assertions are what actually prove the guard fired, not `result.ok`
  // alone.
  const VALID_ROUTES: Record<string, RouteSpec> = {
    [MANIFEST_URL]: { body: utf8(manifestJson()) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
  }

  it('rejects a hostname that resolves to a loopback address, before any fetch happens', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => ['127.0.0.1']

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a link-local address (cloud metadata range)', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => ['169.254.169.254']

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a hinted URL whose host is ALREADY a private-address literal, without ever calling the resolver', async () => {
    const literalRoutes: Record<string, RouteSpec> = {
      'https://10.0.0.5/.well-known/orivon.json': { body: utf8(manifestJson()) },
      'https://10.0.0.5/index.html': { body: utf8('<!doctype html>') }
    }
    const fetchFn = vi.fn(stubFetch(literalRoutes))
    const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('should never resolve a literal') })

    const result = await fetchBundle(fetchFn, 'https://10.0.0.5/', resolveFn)

    expect(result.ok).toBe(false)
    expect(resolveFn).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('accepts a hinted URL whose host is a public-address literal, without ever calling the resolver', async () => {
    const routes: Record<string, RouteSpec> = {
      'https://93.184.216.34/.well-known/orivon.json': { body: utf8(manifestJson()) },
      'https://93.184.216.34/index.html': { body: utf8('<!doctype html>') }
    }
    const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('should never resolve a literal') })

    const result = await fetchBundle(stubFetch(routes), 'https://93.184.216.34/', resolveFn)

    expect(result.ok).toBe(true)
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('rejects when only SOME resolved addresses are public -- every answer must pass, matching connect.ts', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => ['93.184.216.34', '127.0.0.1']

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails closed when the resolver itself rejects', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => { throw new Error('DNS failure') }

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails closed on an empty resolution, matching connect.ts', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => []

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('accepts an ordinary hostname resolving to a single public address', async () => {
    const result = await fetchBundle(stubFetch(VALID_ROUTES), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(true)
  })

  it('rejects when the manifest is actually served from a different origin than requested', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()), url: 'https://evil.example.com/.well-known/orivon.json' }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/origin/i)
  })

  it('rejects when the manifest response resolves to a path other than the well-known one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()), url: `${ORIGIN}/manifest-redirected.json` }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
  })
})

// F2: install-origin.ts's guard used to resolve, validate, then DISCARD the
// validated addresses and return only string | null -- fetchBundle then
// named the host a SECOND time (`${canonicalOrigin}${MANIFEST_PATH}`, by
// hostname) for every fetch it made, each one a fresh, independent
// resolution a low-TTL/rebinding host can answer differently to than the
// guard saw. connect.ts's own discipline (this file's header) is "resolve
// once, hand the caller the validated literals to dial" -- never name the
// host again. These tests prove fetchBundle now follows it: the injected
// resolver runs exactly ONCE for the whole install, and only ITS answer ever
// reaches fetchFn, never a later, un-validated one.
describe('fetchBundle: F2 -- resolves the install origin once and reuses the validated literal(s), never re-resolving mid-install', () => {
  it('never lets any fetch see an address from a SECOND resolveFn call for the same hostname (DNS rebinding)', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') },
      [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)') }
    }
    // A hostile or merely low-TTL nameserver: public on the first lookup,
    // loopback on every lookup after that. If fetchBundle (or anything it
    // calls) ever resolved a second time -- for the asset fetch, say -- this
    // is the answer a rebinding attack would use to reach the user's own
    // machine.
    const answers: Array<readonly string[]> = [['93.184.216.34'], ['127.0.0.1']]
    let resolveCalls = 0
    const resolveFn: Resolver = async () => {
      const answer = answers[Math.min(resolveCalls, answers.length - 1)]
      resolveCalls++
      return answer as readonly string[]
    }
    const pinnedAddressesSeen: Array<readonly string[]> = []
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      pinnedAddressesSeen.push(pinnedAddresses)
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(true)
    expect(resolveCalls).toBe(1)
    expect(pinnedAddressesSeen.length).toBeGreaterThan(0)
    for (const addresses of pinnedAddressesSeen) expect(addresses).toEqual(['93.184.216.34'])
  })

  // F5: the guard used to cover only the manifest fetch -- the asset loop
  // that follows can run for up to BUNDLE_TIMEOUT_MS (10 minutes), each asset
  // a fresh connection, with no re-check at all. Proven separately from the
  // rebind test above, with several assets, so a fix that happened to work
  // only for a single-asset bundle would not pass silently.
  it('reuses the SAME pinned addresses for every asset in a multi-asset bundle, never resolving again', async () => {
    const paths = ['a0.js', 'a1.js', 'a2.js', 'a3.js']
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: utf8('x') }

    let resolveCalls = 0
    const resolveFn: Resolver = async () => { resolveCalls++; return ['93.184.216.34'] }
    const pinnedAddressesSeen: Array<readonly string[]> = []
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      pinnedAddressesSeen.push(pinnedAddresses)
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(true)
    expect(resolveCalls).toBe(1)
    // One call for the manifest, one per asset.
    expect(pinnedAddressesSeen).toHaveLength(1 + paths.length)
    for (const addresses of pinnedAddressesSeen) expect(addresses).toEqual(['93.184.216.34'])
  })
})

// F6: `resolveFn` carries no timeout of its own (Resolver's own doc comment
// in connect.ts) -- a hint pointing at a deliberately stalling nameserver
// used to hang with no clock at all, reopening the unbounded-duration T11b
// DoS BUNDLE_TIMEOUT_MS exists to close, because the guard's own `await` used
// to sit above where the deadline started.
describe('fetchBundle: F6 -- the install-origin guard\'s own resolution is bounded by the bundle deadline', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('rejects once BUNDLE_TIMEOUT_MS elapses while resolveFn never resolves, rather than hanging forever', async () => {
    const stallingResolver: Resolver = async () => await new Promise<never>(() => {})
    const pending = fetchBundle(stubFetch({}), ORIGIN, stallingResolver)

    await vi.advanceTimersByTimeAsync(BUNDLE_TIMEOUT_MS + 1)
    const result = await pending

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/overall deadline/i)
  })
})

// F7/T13c: an http:// install origin currently passed the guard and got
// fetched and pinned over cleartext, where an on-path attacker can
// substitute the bundle outright -- there is no TLS certificate to have been
// wrong. Mirrors policy/origin.ts's isPersistableOrigin, which refuses
// `http:` for the same reason.
describe('fetchBundle: F7 -- refuses a plain-http install origin outright', () => {
  it('rejects before ever calling resolveFn or fetchFn', async () => {
    const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('should never resolve') })
    const fetchFn = vi.fn(stubFetch({}))

    const result = await fetchBundle(fetchFn, 'http://app.example.com/', resolveFn)

    expect(result.ok).toBe(false)
    expect(resolveFn).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

// F8: `classifyAddress` only recognises address LITERALS -- `localhost` and
// `app.localhost` are names, so without an explicit check they fall through
// to `resolveFn`, whose answer is resolver-dependent, while Chromium maps the
// WHOLE `.localhost` subtree to loopback per RFC 6761 without ever consulting
// DNS. Mirrors policy/origin.ts's own `.localhost` namespace check.
describe('fetchBundle: F8 -- refuses the whole .localhost namespace by name, not just the bare label', () => {
  it.each(['https://localhost/', 'https://app.localhost/', 'https://deeply.nested.localhost/'])(
    'rejects %s before ever calling resolveFn', async (hintedUrl) => {
      const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('should never resolve') })

      const result = await fetchBundle(stubFetch({}), hintedUrl, resolveFn)

      expect(result.ok).toBe(false)
      expect(resolveFn).not.toHaveBeenCalled()
    }
  )
})

// F9: connect.ts's own MAX_ANSWERS bounds the number of resolver answers it
// will iterate, citing T11b (answer count is DNS-controlled, not
// grant-controlled). The install-origin guard iterated an unbounded list.
describe('fetchBundle: F9 -- bounds the number of resolved addresses it will iterate', () => {
  it('rejects a resolution with more than MAX_ANSWERS addresses', async () => {
    const tooMany = Array.from({ length: MAX_ANSWERS + 1 }, (_, i) => `1.1.1.${String(i + 1)}`)
    const resolveFn: Resolver = async () => tooMany
    const fetchFn = vi.fn(stubFetch({}))

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn)

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('still accepts a resolution with exactly MAX_ANSWERS addresses -- no off-by-one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const exactlyMax = Array.from({ length: MAX_ANSWERS }, (_, i) => `1.1.1.${String(i + 1)}`)
    const resolveFn: Resolver = async () => exactlyMax

    const result = await fetchBundle(stubFetch(routes), ORIGIN, resolveFn)

    expect(result.ok).toBe(true)
  })
})

// IPv6 and other address-class edge cases the pre-existing suite (IPv4 only)
// never exercised at the fetchBundle level -- address.test.ts already proves
// classifyAddress itself gets each of these right; these prove the guard
// actually reaches that table for a LITERAL install origin in each class,
// end to end, before any fetch happens.
describe('fetchBundle: IPv6 and other edge-case address literals are refused, matching connect.ts\'s table', () => {
  it.each([
    ['::1 (loopback)', 'https://[::1]/'],
    ['::ffff:127.0.0.1 (IPv4-mapped loopback -- the classic IPv4-table bypass)', 'https://[::ffff:127.0.0.1]/'],
    ['fe80:: (link-local)', 'https://[fe80::1]/'],
    ['fc00:: (unique local)', 'https://[fc00::1]/'],
    ['fd00:: (unique local)', 'https://[fd00::1]/'],
    ['0.0.0.0 (unspecified v4 -- resolves to 127.0.0.1 on Linux/macOS)', 'https://0.0.0.0/'],
    [':: (unspecified v6 -- resolves to 127.0.0.1 on Linux/macOS)', 'https://[::]/']
  ])('rejects %s, without ever calling fetchFn or resolveFn', async (_label, hintedUrl) => {
    const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('a literal must never be resolved') })
    const fetchFn = vi.fn(stubFetch({}))

    const result = await fetchBundle(fetchFn, hintedUrl, resolveFn)

    expect(result.ok).toBe(false)
    expect(resolveFn).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('accepts an ordinary public IPv6 literal', async () => {
    const publicV6 = 'https://[2606:4700:4700::1111]/'
    const routes: Record<string, RouteSpec> = {
      'https://[2606:4700:4700::1111]/.well-known/orivon.json': { body: utf8(manifestJson()) },
      'https://[2606:4700:4700::1111]/index.html': { body: utf8('<!doctype html>') }
    }
    const resolveFn = vi.fn(async (): Promise<readonly string[]> => { throw new Error('a literal must never be resolved') })

    const result = await fetchBundle(stubFetch(routes), publicV6, resolveFn)

    expect(result.ok).toBe(true)
    expect(resolveFn).not.toHaveBeenCalled()
  })
})

describe('fetchBundle: manifest fetch and validation failures', () => {
  it('rejects a network failure fetching the manifest', async () => {
    const failing: Fetch = async () => { throw new Error('DNS failure') }
    const result = await fetchBundle(failing, ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/DNS failure/)
  })

  it('rejects a non-ok HTTP status fetching the manifest', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { status: 404, body: utf8('') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/404/)
  })

  it('surfaces parseManifest\'s own rejection reason for malformed JSON', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8('{not json') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid JSON/)
  })
})

describe('fetchBundle: Manifest.entry must have a leaf (ADR-0009 amendment #2)', () => {
  it('rejects a bundle with no leaf at the manifest\'s declared entry point', async () => {
    // Entry is now always one of the fetched assetPaths (it is unioned in
    // unconditionally, ADR-0011), so a route that simply does not exist
    // surfaces as a fetch failure, not a missing-leaf rejection -- this
    // check is only reachable when the fetch SUCCEEDS but at a different
    // canonical path than `manifest.entry` names: a redirect. `entryPath`
    // is computed from the declared string alone, ignoring where the
    // response actually resolved to, so a redirected entry lands in
    // `entries` under a path that never matches it.
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'index.html' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('x'), url: `${ORIGIN}/other.html` }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/entry/i)
  })
})

describe('fetchBundle: byte caps enforced before holding the whole bundle', () => {
  it('rejects an asset whose actual bytes exceed MAX_ASSET_BYTES', async () => {
    const oversized = new Uint8Array(MAX_ASSET_BYTES + 1)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: oversized }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })

  it('fails fast on a declared Content-Length over MAX_ASSET_BYTES -- never reads the body', async () => {
    const bodyReads = new Set<string>()
    const assetUrl = `${ORIGIN}/huge.bin`
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'huge.bin' })) },
      [assetUrl]: { body: utf8('tiny'), headers: { 'content-length': String(MAX_ASSET_BYTES + 1) } }
    }
    const result = await fetchBundle(stubFetch(routes, bodyReads), ORIGIN, PUBLIC_RESOLVER)
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
    const paths = ['a0.bin', 'a1.bin', 'a2.bin', 'a3.bin', 'a4.bin', 'a5.bin']
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) {
      routes[`${ORIGIN}/${path}`] = { body: new Uint8Array(perAsset) }
    }
    const requested: string[] = []
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      requested.push(url)
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER)
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
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'huge.bin' })) },
      [assetUrl]: { body: new Uint8Array(0), infinite: true }
    }
    const result = await fetchBundle(stubFetch(routes, undefined, streamed), ORIGIN, PUBLIC_RESOLVER)
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
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'lying.bin' })) },
      [assetUrl]: { body: oversized, headers: { 'content-length': '10' } }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })

  it('accepts a body whose actual size is exactly MAX_ASSET_BYTES -- no off-by-one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: new Uint8Array(MAX_ASSET_BYTES) }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(true)
  })

  it('still enforces the cumulative MAX_BUNDLE_BYTES budget across several under-cap assets', async () => {
    // Same scenario the pre-existing suite above already covers end-to-end
    // (a 6th asset must never be requested once the running total tips the
    // budget); restated here beside the streaming tests as the third caller
    // this fix's brief names explicitly.
    const perAsset = 14 * 1024 * 1024
    const paths = ['a0.bin', 'a1.bin', 'a2.bin', 'a3.bin', 'a4.bin', 'a5.bin']
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: new Uint8Array(perAsset) }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
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
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
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
    const pending = fetchBundle(stalls, ORIGIN, PUBLIC_RESOLVER)
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
    const pending = fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
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
    const paths = Array.from({ length: assetCount }, (_, i) => `a${String(i)}.js`)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: utf8('x') }

    const requested: string[] = []
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      requested.push(url)
      if (url !== MANIFEST_URL) await new Promise<void>((resolve) => setTimeout(resolve, perAssetDelay))
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }

    const pending = fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER)
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

describe('fetchBundle: delegates structural rejection to bundleTree', () => {
  it('rejects two manifest-declared assets whose SERVED (redirected) locations collide under case-folding', async () => {
    // Two manifest-level names that differ only by case ('App.js'/'app.js')
    // are now caught earlier, by manifest.ts's own collisionKey check
    // (readAssets) -- covered there, not here (Rule 3). What manifest.ts
    // cannot see is a REDIRECT: 'other.js' is declared as its own asset,
    // fetched from a URL that resolves (via RouteSpec's `url` override) to
    // the SAME canonical path 'app.js' already occupies. bundleTree()'s own
    // collision check is what still catches this -- the two declared names
    // are distinct strings, so nothing upstream of it ever sees a problem.
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js', 'other.js'] })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') },
      [`${ORIGIN}/app.js`]: { body: utf8('a') },
      [`${ORIGIN}/other.js`]: { body: utf8('b'), url: `${ORIGIN}/app.js` }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/collide/)
  })
})
