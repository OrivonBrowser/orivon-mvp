import { describe, expect, it, vi } from 'vitest'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { fromBundleTree, isPinnedPath } from '../../broker/policy/pin.js'
import type { ConnectSecureDecision } from '../../broker/policy/connect-secure.js'
import { createAppRequestHandler, resolveRequestPath, verifiedManifestFor } from '../serve.js'
import type { AuthoriseReach, ReachDial } from '../serve.js'
import { manifestJson, memoryStorage, ORIGIN, utf8 } from './test-helpers.js'

const INDEX_HTML = '<h1>hello orivon</h1>'
const APP_JS = 'console.log("hi")'.padEnd(300, ' /* padding for a real range test */ ')

async function installedStorage (): Promise<ReturnType<typeof memoryStorage>> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8(INDEX_HTML) },
    { path: '/app.js', content: utf8(APP_JS) }
  ]
  const tree = await bundleTree(entries)
  const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)
  const storage = memoryStorage()
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, pin)
  return storage
}

describe('resolveRequestPath', () => {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8(INDEX_HTML) }
  ]

  it('maps the bare root to the entry path, when the entry is pinned', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)
    expect(isPinnedPath(pin, '/index.html')).toBe(true)

    const resolved = resolveRequestPath('/index.html', pin, `${ORIGIN}/`)
    expect(resolved).toEqual({ ok: true, canonicalPath: '/index.html' })
  })

  it('denies the root when the entry path is not itself pinned', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath('/not-actually-pinned.html', pin, `${ORIGIN}/`)
    expect(resolved.ok).toBe(false)
  })

  it('denies the root when entryPath itself is null (an unresolvable entry)', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath(null, pin, `${ORIGIN}/`)
    expect(resolved.ok).toBe(false)
  })

  it('serves an exact pinned path outside the root', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath('/index.html', pin, `${ORIGIN}/index.html`)
    expect(resolved).toEqual({ ok: true, canonicalPath: '/index.html' })
  })

  it('THE FAIL-CLOSED RULE: denies a path that is structurally valid but simply not in the pinned set', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath('/index.html', pin, `${ORIGIN}/not-pinned.js`)
    expect(resolved.ok).toBe(false)
  })

  it('denies a directory-ish path other than the bare root -- no directory index fallback beyond "/"', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath('/index.html', pin, `${ORIGIN}/subdir/`)
    expect(resolved.ok).toBe(false)
  })

  it('never serves the pin record itself -- "/pin.json" is not a canonical asset path any bundle can pin', async () => {
    const tree = await bundleTree(entries)
    const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)

    const resolved = resolveRequestPath('/index.html', pin, `${ORIGIN}/pin.json`)
    expect(resolved.ok).toBe(false)
  })
})

describe('createAppRequestHandler', () => {
  it('denies every request when this origin has never been pinned', async () => {
    const handler = await createAppRequestHandler(memoryStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(404)
  })

  it('denies every request when the pinned tree fails re-verification (a tampered asset)', async () => {
    const storage = await installedStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('tampered after pinning'))

    const handler = await createAppRequestHandler(storage, ORIGIN)
    const index = await handler(new Request(`${ORIGIN}/`))
    const asset = await handler(new Request(`${ORIGIN}/app.js`))
    expect(index.status).toBe(404)
    expect(asset.status).toBe(404)
  })

  it('serves "/" as the manifest\'s entry, with the right content and Content-Type', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe(INDEX_HTML)
  })

  it('serves a pinned asset at its own path', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/app.js`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await response.text()).toBe(APP_JS)
  })

  it('THE FAIL-CLOSED RULE, end to end through the handler: a planted file at this origin, never part of the pinned manifest, is refused', async () => {
    const storage = await installedStorage()
    // Plants a file directly on the backing store at this origin, bypassing
    // install() entirely -- exactly what an out-of-band write (or a
    // compromised prior version's leftover file) would look like on disk.
    await storage.writeAsset(ORIGIN, '/evil.js', utf8('alert(1)'))

    const handler = await createAppRequestHandler(storage, ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/evil.js`))

    expect(response.status).toBe(404)
  })

  it('denies a request whose own origin differs from this handler\'s app origin, when nothing wires up third-party reach at all', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request('https://not-this-app.example/app.js'))

    expect(response.status).toBe(404)
  })

  it('never serves the pin record even if it is directly requested by name', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/pin.json`))

    expect(response.status).toBe(404)
  })

  it('a satisfiable Range request returns 206 with the correct slice and Content-Range', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=0-4' } }))

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-4/${utf8(APP_JS).length}`)
    expect(await response.text()).toBe(APP_JS.slice(0, 5))
  })

  it('an unsatisfiable Range request returns 416', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const total = utf8(APP_JS).length
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: `bytes=${total + 10}-${total + 20}` } }))

    expect(response.status).toBe(416)
  })

  it('a request for an asset that vanished from disk AFTER handler creation is denied, not thrown', async () => {
    const storage = await installedStorage()
    const handler = await createAppRequestHandler(storage, ORIGIN)
    // Simulate the asset disappearing mid-session, after the whole-tree
    // verification that ran when the handler was built.
    storage.assets.get(ORIGIN)?.delete('/app.js')

    const response = await handler(new Request(`${ORIGIN}/app.js`))
    expect(response.status).toBe(404)
  })
})

// A158's early-hydration seam: the SAME verified manifest
// createAppRequestHandler derives internally, exposed so a caller can
// hydrate GrantLedger from it before registering anything servable.
describe('verifiedManifestFor', () => {
  it('returns the pinned manifest once the whole tree verifies', async () => {
    const manifest = await verifiedManifestFor(await installedStorage(), ORIGIN)

    expect(manifest?.entry).toBe('index.html')
  })

  it('is undefined when this origin has never been pinned', async () => {
    expect(await verifiedManifestFor(memoryStorage(), ORIGIN)).toBeUndefined()
  })

  it('is undefined when the pinned tree fails re-verification (a tampered asset) -- never falls back to the unverified bytes on disk', async () => {
    const storage = await installedStorage()
    await storage.writeAsset(ORIGIN, '/app.js', utf8('tampered after pinning'))

    expect(await verifiedManifestFor(storage, ORIGIN)).toBeUndefined()
  })
})

const DEFAULT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'"

describe('createAppRequestHandler -- CSP (S4-6, ADR-0007/ADR-0006)', () => {
  it('sets a self-only CSP when no live grant source is given', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`))

    expect(response.headers.get('content-security-policy')).toBe(DEFAULT_CSP)
  })

  it('widens connect-src to the live granted tcp.connect patterns', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN, async () => ['api.example.com:443'])
    const response = await handler(new Request(`${ORIGIN}/`))

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' api.example.com:443; " +
      "img-src 'self'; font-src 'self'; media-src 'self'"
    )
  })

  it('reads the grant source fresh on every request -- a revoke narrows the very next request through the SAME already-built handler', async () => {
    let live: string[] = ['api.example.com:443']
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN, async () => live)

    const before = await handler(new Request(`${ORIGIN}/`))
    expect(before.headers.get('content-security-policy')).toContain('api.example.com:443')

    live = [] // simulates broker.revoke() landing between the two requests
    const after = await handler(new Request(`${ORIGIN}/`))
    expect(after.headers.get('content-security-policy')).toBe(DEFAULT_CSP)
  })

  it('sets the CSP on every served asset, not only the entry document -- a worker script inherits its OWN response\'s CSP', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN, async () => ['a.example:443'])
    const response = await handler(new Request(`${ORIGIN}/app.js`))

    expect(response.headers.get('content-security-policy')).toContain('a.example:443')
  })

  it('sets the CSP on a 206 partial response too', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=0-4' } }))

    expect(response.status).toBe(206)
    expect(response.headers.get('content-security-policy')).toBe(DEFAULT_CSP)
  })

  it('sets the CSP on a 416 unsatisfiable-range response too', async () => {
    const handler = await createAppRequestHandler(await installedStorage(), ORIGIN)
    const total = utf8(APP_JS).length
    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: `bytes=${total + 10}-${total + 20}` } }))

    expect(response.status).toBe(416)
    expect(response.headers.get('content-security-policy')).toBe(DEFAULT_CSP)
  })

  it('widens img-src/font-src/media-src to the live granted https.connect patterns, independently of connect-src\'s own tcp.connect grant', async () => {
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, async () => ['api.example.com:443'], async () => ['cdn.example.com:443']
    )
    const response = await handler(new Request(`${ORIGIN}/`))

    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("connect-src 'self' api.example.com:443")
    expect(csp).toContain("img-src 'self' cdn.example.com:443; font-src 'self' cdn.example.com:443; media-src 'self' cdn.example.com:443")
  })
})

describe('createAppRequestHandler -- fetchThirdParty (A143, third-party reach)', () => {
  /** `decision.allowed === true` always answers `hostArg` as `.host` -- checkConnectSecure's own contract, mirrored here rather than re-deriving it. */
  function allow (host: string): ConnectSecureDecision {
    return { allowed: true, host }
  }

  const DENIED: ConnectSecureDecision = { allowed: false, code: 'denied', reason: 'no-pattern-match' }

  it('THE BROKEN-GATE PROOF: an ungranted host never reaches reachDial -- proven by a spy the test fails if it is ever called', async () => {
    const authoriseReach: AuthoriseReach = vi.fn(async () => DENIED)
    const reachDial: ReachDial = vi.fn(async () => new Response('should never be seen'))
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    const response = await handler(new Request('https://not-granted.example/font.woff2'))

    expect(response.status).toBe(404)
    expect(reachDial).not.toHaveBeenCalled()
    expect(authoriseReach).toHaveBeenCalledWith('not-granted.example', 443)
  })

  it('a granted host reaches reachDial, dialled at the AUTHORISED (canonical) host/port, and returns exactly what it answers', async () => {
    const upstream = new Response('real bytes', { status: 200, headers: { 'content-type': 'font/woff2' } })
    const reachDial: ReachDial = vi.fn(async () => upstream)
    const authoriseReach: AuthoriseReach = async (host, port) => allow(host === 'granted.example' && port === 443 ? host : 'wrong')
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    const response = await handler(new Request('https://granted.example/font.woff2'))

    expect(response).toBe(upstream)
    expect(reachDial).toHaveBeenCalledTimes(1)
    const call = vi.mocked(reachDial).mock.calls[0]
    if (call === undefined) throw new Error('reachDial was never called')
    const [, dialedHost, dialedPort] = call
    expect(dialedHost).toBe('granted.example')
    expect(dialedPort).toBe(443)
  })

  it('a request without an explicit port defaults to 443 for both the authorisation check and the dial', async () => {
    const authoriseReach: AuthoriseReach = vi.fn(async () => allow('granted.example'))
    const reachDial: ReachDial = vi.fn(async () => new Response(null))
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    await handler(new Request('https://granted.example/img.png'))

    expect(authoriseReach).toHaveBeenCalledWith('granted.example', 443)
    const call = vi.mocked(reachDial).mock.calls[0]
    if (call === undefined) throw new Error('reachDial was never called')
    const [, , dialedPort] = call
    expect(dialedPort).toBe(443)
  })

  it('plain http: stays denied even when authoriseReach would allow it and reachDial is wired -- there is no address-safe way to authorise it (see fetchThirdParty\'s own doc)', async () => {
    const authoriseReach: AuthoriseReach = vi.fn(async () => allow('granted.example'))
    const reachDial: ReachDial = vi.fn(async () => new Response('should never be seen'))
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    const response = await handler(new Request('http://granted.example/img.png'))

    expect(response.status).toBe(404)
    expect(authoriseReach).not.toHaveBeenCalled()
    expect(reachDial).not.toHaveBeenCalled()
  })

  it('reachDial throwing (a real connection failure) is turned into a denial, not an unhandled rejection', async () => {
    const authoriseReach: AuthoriseReach = async () => allow('granted.example')
    const reachDial: ReachDial = async () => { throw new Error('ECONNREFUSED') }
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    const response = await handler(new Request('https://granted.example/img.png'))

    expect(response.status).toBe(404)
  })

  it('authoriseReach is asked FRESH on every request -- a revoke narrows the very next request through the SAME already-built handler', async () => {
    let allowed = true
    const authoriseReach: AuthoriseReach = async (host) => (allowed ? allow(host) : DENIED)
    const reachDial: ReachDial = async () => new Response('bytes')
    const handler = await createAppRequestHandler(
      await installedStorage(), ORIGIN, undefined, undefined, authoriseReach, reachDial
    )

    const before = await handler(new Request('https://granted.example/img.png'))
    expect(before.status).toBe(200)

    allowed = false // simulates broker.revoke() landing between the two requests
    const after = await handler(new Request('https://granted.example/img.png'))
    expect(after.status).toBe(404)
  })
})
