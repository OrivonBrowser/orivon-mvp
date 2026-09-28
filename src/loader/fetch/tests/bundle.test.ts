import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../../../broker/policy/bundle-hash.js'
import { MAX_ANSWERS } from '../../../broker/policy/connect.js'
import type { Resolver } from '../../../broker/policy/connect.js'
import { BUNDLE_TIMEOUT_MS, FETCH_IDLE_TIMEOUT_MS, fetchBundle } from '../bundle.js'
import type { Fetch } from '../bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'
import type { RouteSpec } from '../../tests/test-helpers.js'

describe('fetchBundle: happy path', () => {
  it('fetches the manifest, the entry, and every manifest-declared asset, and pins the entry leaf', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
      [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
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
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(true)
  })
})

describe('fetchBundle: origin and discovery', () => {
  it('rejects a hintedUrl that is not a valid origin', async () => {
    const result = await fetchBundle(stubFetch({}), 'not a url', PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
  })

  it('always fetches exactly <origin>/.well-known/orivon.json, ignoring a hinted path', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: 'a.html' })) },
      [`${ORIGIN}/a.html`]: { body: utf8('x') }
    }
    const result = await fetchBundle(stubFetch(routes), `${ORIGIN}/some/page.html`, PUBLIC_RESOLVER, memoryStorage())
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

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a link-local address (cloud metadata range)', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => ['169.254.169.254']

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

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

    const result = await fetchBundle(fetchFn, 'https://10.0.0.5/', resolveFn, memoryStorage())

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

    const result = await fetchBundle(stubFetch(routes), 'https://93.184.216.34/', resolveFn, memoryStorage())

    expect(result.ok).toBe(true)
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('rejects when only SOME resolved addresses are public -- every answer must pass, matching connect.ts', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => ['93.184.216.34', '127.0.0.1']

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails closed when the resolver itself rejects', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => { throw new Error('DNS failure') }

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails closed on an empty resolution, matching connect.ts', async () => {
    const fetchFn = vi.fn(stubFetch(VALID_ROUTES))
    const resolveFn: Resolver = async () => []

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('accepts an ordinary hostname resolving to a single public address', async () => {
    const result = await fetchBundle(stubFetch(VALID_ROUTES), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(true)
  })

})

// A141: real Electron's net.fetch reports response.url as the empty string
// on every ordinary, non-redirected response (docs/open-questions.md A59) --
// not sometimes, always. fetchBundle used to read response.url as its sole
// source of truth for the checks above, which made it reject every fetch,
// including a completely honest one: originFromUrl('') is null, so
// `manifestOrigin !== canonicalOrigin` was always true. These checks now
// trust the REQUESTED url instead (see fetch/bundle.ts's own comment on
// why that is safe), so a `Fetch` implementation reporting url exactly like
// the real one does must still succeed.
//
// This is also why two tests that used to live in the describe block above
// are gone rather than fixed in place: both simulated a redirect landing the
// manifest at a different origin/path by having the stub report a mismatched
// `response.url` (RouteSpec's `url` override). fetchBundle no longer reads
// that field at all, so no `Fetch` stub can make it diverge from the
// requested url through this public API any more -- the origin/path
// guarantee now rests entirely on the `Fetch` implementation itself refusing
// to follow a redirect (see fetch/budget.ts's own `Fetch` doc comment).
describe('fetchBundle: A141 -- must not depend on response.url', () => {
  it('succeeds even though the fetch adapter reports url \'\' on every response, matching real Electron', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })), url: '' },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>'), url: '' },
      [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)'), url: '' }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(true)
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

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

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

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

    expect(result.ok).toBe(true)
    expect(resolveCalls).toBe(1)
    // One call for the manifest, one for the published DDOC hash tree, one per asset.
    expect(pinnedAddressesSeen).toHaveLength(2 + paths.length)
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
    const pending = fetchBundle(stubFetch({}), ORIGIN, stallingResolver, memoryStorage())

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

    const result = await fetchBundle(fetchFn, 'http://app.example.com/', resolveFn, memoryStorage())

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

      const result = await fetchBundle(stubFetch({}), hintedUrl, resolveFn, memoryStorage())

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

    const result = await fetchBundle(fetchFn, ORIGIN, resolveFn, memoryStorage())

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

    const result = await fetchBundle(stubFetch(routes), ORIGIN, resolveFn, memoryStorage())

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

    const result = await fetchBundle(fetchFn, hintedUrl, resolveFn, memoryStorage())

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

    const result = await fetchBundle(stubFetch(routes), publicV6, resolveFn, memoryStorage())

    expect(result.ok).toBe(true)
    expect(resolveFn).not.toHaveBeenCalled()
  })
})

describe('fetchBundle: manifest fetch and validation failures', () => {
  it('rejects a network failure fetching the manifest', async () => {
    const failing: Fetch = async () => { throw new Error('DNS failure') }
    const result = await fetchBundle(failing, ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/DNS failure/)
  })

  it('rejects a non-ok HTTP status fetching the manifest', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { status: 404, body: utf8('') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/404/)
  })

  it('surfaces parseManifest\'s own rejection reason for malformed JSON', async () => {
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8('{not json') } }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid JSON/)
  })
})

// fetchBundle: Manifest.entry must have a leaf (ADR-0009 amendment #2) --
// the check itself is still in fetch/bundle.ts, but A141 removed the only
// way this suite had to reach its failing branch. It used to fire when a
// stubbed redirect (RouteSpec's `url` override) landed the entry asset's
// SERVED path at something other than its declared one; entryPath and the
// asset loop's own canonicalPath are both derived from the REQUESTED url
// now, by the identical computation for the entry's own asset, so the two
// can no longer disagree through this public API. See
// src/loader/README.md, Design notes, for the fuller account.

describe('fetchBundle: byte caps enforced before holding the whole bundle', () => {
  it('rejects an asset whose actual bytes exceed MAX_ASSET_BYTES', async () => {
    const oversized = new Uint8Array(MAX_ASSET_BYTES + 1)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: oversized }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
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
    const result = await fetchBundle(stubFetch(routes, bodyReads), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    expect(bodyReads.has(assetUrl)).toBe(false)
  })

  it('stops starting further assets once the shared running total exceeds the bundle budget', async () => {
    // The running total is tracked from ACTUAL downloaded bytes, never a
    // declared Content-Length, and is shared by every asset in flight at
    // once. Small limits stand in for MAX_ASSET_BYTES/MAX_BUNDLE_BYTES so the
    // fixture stays small: twelve 14 KiB assets against a 64 KiB budget run
    // out after the fifth, so the last ones are never requested at all.
    const limits = { assetBytes: 16 * 1024, bundleBytes: 64 * 1024 }
    const paths = Array.from({ length: 12 }, (_, i) => `a${String(i)}.bin`)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: new Uint8Array(14 * 1024) }
    const requested: string[] = []
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      requested.push(url)
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), limits)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_BUNDLE_BYTES/)
    expect(requested).not.toContain(`${ORIGIN}/a11.bin`)
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
    const result = await fetchBundle(stubFetch(routes, undefined, streamed), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
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
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/MAX_ASSET_BYTES/)
  })

  it('accepts a body whose actual size is exactly MAX_ASSET_BYTES -- no off-by-one', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: new Uint8Array(MAX_ASSET_BYTES) }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(true)
  })

  it('clears everything it staged when the bundle is refused part-way through', async () => {
    const limits = { assetBytes: 16 * 1024, bundleBytes: 64 * 1024 }
    const paths = Array.from({ length: 6 }, (_, i) => `a${String(i)}.bin`)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: new Uint8Array(14 * 1024) }
    const storage = memoryStorage()
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, storage, limits)
    expect(result.ok).toBe(false)
    expect(storage.staged.size).toBe(0)
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
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
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
    const pending = fetchBundle(stalls, ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    await vi.advanceTimersByTimeAsync(FETCH_IDLE_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/timed out/i)
  })

  it('aborts a body read that never completes', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: new Uint8Array(0), stall: true }
    }
    const pending = fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    await vi.advanceTimersByTimeAsync(FETCH_IDLE_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/timed out/i)
  })
})

describe('fetchBundle: a bundle-wide deadline bounds the whole install, not just one asset', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('cuts off a peer that trickles one byte just inside the idle deadline, forever, once BUNDLE_TIMEOUT_MS elapses', async () => {
    // FETCH_IDLE_TIMEOUT_MS never fires against this body -- a byte always
    // arrives in time -- so only the bundle-wide deadline can end it.
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      if (url === MANIFEST_URL) return await stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson()) } })(url, pinnedAddresses, signal)
      const body = new ReadableStream<Uint8Array>({
        async pull (controller) {
          await new Promise<void>((resolve) => setTimeout(resolve, FETCH_IDLE_TIMEOUT_MS - 1))
          controller.enqueue(new Uint8Array(1))
        }
      }, { highWaterMark: 0 })
      return { ok: true, status: 200, url, body, arrayBuffer: async () => new ArrayBuffer(0) }
    }

    const pending = fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    await vi.advanceTimersByTimeAsync(BUNDLE_TIMEOUT_MS + FETCH_IDLE_TIMEOUT_MS)
    const result = await pending

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/overall deadline/i)
    expect(result.reason).toMatch(String(BUNDLE_TIMEOUT_MS))
  })
})

// fetchBundle: delegates structural rejection to bundleTree -- this used to
// hold a test proving a REDIRECT could land two declared asset names at the
// same served canonical path, simulated via a stubbed RouteSpec `url`
// override. A141 removed fetchBundle's only way to see that: every asset's
// canonical path is now the requested one, computed straight from the
// manifest's own declared (and already collision-checked) relative path, so
// two distinct declared names can no longer collide through this public API
// -- see src/loader/README.md, Design notes. bundleTree()'s own case-folding
// collision check keeps direct coverage in
// src/broker/policy/tests/bundle-hash.test.ts instead.
