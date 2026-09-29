import { describe, expect, it, vi } from 'vitest'
import type { OnHeadersReceivedListenerDetails } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { ResponseHeadersResult } from '../../sessions/web-request-owner.js'

const { served, liveCspHeaderFor } = vi.hoisted(() => ({
  served: new Set<string>(),
  liveCspHeaderFor: vi.fn(async () => "default-src 'self'; script-src 'self'")
}))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin),
  liveCspHeaderFor
}))

const { defaultSessionGrantedOriginCsp, documentOriginOf, GRANTED_ORIGIN_CSP_FILTER, withAppendedCsp } = await import('../granted-origin-csp.js')

const ORIGIN = 'http://127.0.0.1:8874'
const CSP = "default-src 'self'; script-src 'self'"

function details (overrides: Partial<OnHeadersReceivedListenerDetails>): OnHeadersReceivedListenerDetails {
  return {
    id: 1,
    url: `${ORIGIN}/`,
    method: 'GET',
    resourceType: 'mainFrame',
    referrer: '',
    timestamp: 0,
    statusLine: 'HTTP/1.1 200 OK',
    statusCode: 200,
    responseHeaders: { 'Content-Type': ['text/html'] },
    ...overrides
  }
}

function brokerWith (opts: { hasGrant?: boolean, isolated?: boolean, manifestFails?: boolean } = {}): Broker {
  return {
    app: {
      hasGrantsSync: () => opts.hasGrant === true,
      manifest: async () => {
        if (opts.manifestFails === true) throw new Error('unregistered')
        return { crossOriginIsolated: opts.isolated === true }
      }
    }
  } as unknown as Broker
}

describe('GRANTED_ORIGIN_CSP_FILTER', () => {
  it('includes object, alongside mainFrame/subFrame, so a nested <object>/<embed> document reaches the handler', () => {
    expect(GRANTED_ORIGIN_CSP_FILTER.types).toEqual(expect.arrayContaining(['mainFrame', 'subFrame', 'object']))
  })

  it('includes script, so a worker\'s own script response reaches the handler', () => {
    expect(GRANTED_ORIGIN_CSP_FILTER.types).toEqual(expect.arrayContaining(['script']))
  })
})

describe('withAppendedCsp', () => {
  it('adds the policy when the server sent none', () => {
    expect(withAppendedCsp({ 'Content-Type': ['text/html'] }, CSP)).toEqual({
      'Content-Type': ['text/html'],
      'Content-Security-Policy': [CSP]
    })
  })

  it('keeps the server\'s own policy beside it, under the server\'s own spelling -- the browser enforces both', () => {
    expect(withAppendedCsp({ 'content-security-policy': ["frame-ancestors 'none'"] }, CSP)).toEqual({
      'content-security-policy': ["frame-ancestors 'none'", CSP]
    })
  })

  it('tolerates a response with no headers at all', () => {
    expect(withAppendedCsp(undefined, CSP)).toEqual({ 'Content-Security-Policy': [CSP] })
  })
})

describe('documentOriginOf', () => {
  it('is the origin for a mainFrame response', () => {
    expect(documentOriginOf(details({ resourceType: 'mainFrame', url: `${ORIGIN}/page` }))).toBe(ORIGIN)
  })

  it('is the origin for a subFrame response too', () => {
    expect(documentOriginOf(details({ resourceType: 'subFrame', url: `${ORIGIN}/frame.html` }))).toBe(ORIGIN)
  })

  // Electron 44 reports a same-origin <object>/<embed> document's own
  // response as resourceType 'object' (measured) -- treated as a document
  // here too, so it gets the granted-origin CSP's no-'unsafe-inline' policy
  // rather than falling through to the app's own, csp.ts's object-src
  // 'none' being the other lock on the same route.
  it('is the origin for an object response too', () => {
    expect(documentOriginOf(details({ resourceType: 'object', url: `${ORIGIN}/nested.html` }))).toBe(ORIGIN)
  })

  it('is null for every non-document resource type', () => {
    for (const resourceType of ['script', 'xhr', 'image', 'stylesheet', 'other'] as const) {
      expect(documentOriginOf(details({ resourceType, url: `${ORIGIN}/app.js` }))).toBeNull()
    }
  })

  it('is null when the URL cannot be parsed', () => {
    expect(documentOriginOf(details({ url: 'not a url' }))).toBeNull()
  })

  // `http://localhost.` (a trailing dot) and `http://localhost` parse to two
  // DIFFERENT `new URL(...).origin` strings but the SAME `originFromUrl` --
  // and it is `originFromUrl` the broker and `tab-view.ts`'s
  // `partitionForTarget` both use to key this origin's grants and partition,
  // so the dotted spelling must name the same origin as the canonical one.
  it('names the trailing-dot spelling of an origin by its canonical form', () => {
    expect(documentOriginOf(details({ url: 'http://localhost.:8874/' }))).toBe('http://localhost:8874')
  })
})

describe('defaultSessionGrantedOriginCsp -- the default session\'s one handler for every granted-without-install origin', () => {
  const SEED: ResponseHeadersResult = { responseHeaders: {} }

  it('gives a document from a granted origin the policy, built fresh per response', async () => {
    served.clear()
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true }))

    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const first = await handler(details({}), SEED)
    expect(first.responseHeaders['Content-Security-Policy']).toEqual([CSP])

    liveCspHeaderFor.mockResolvedValueOnce("default-src 'none'")
    const second = await handler(details({ resourceType: 'subFrame', url: `${ORIGIN}/frame.html` }), SEED)
    expect(second.responseHeaders['Content-Security-Policy']).toEqual(["default-src 'none'"])
  })

  it('leaves a response type that could never be a document or a worker script untouched, and never asks the broker or the grant read at all', async () => {
    served.clear()
    liveCspHeaderFor.mockClear()
    const hasGrantsSync = vi.fn(() => true)
    const handler = defaultSessionGrantedOriginCsp({ app: { hasGrantsSync, manifest: vi.fn() } } as unknown as Broker)
    for (const resourceType of ['xhr', 'image', 'stylesheet'] as const) {
      expect(await handler(details({ resourceType, url: `${ORIGIN}/app.js` }), SEED)).toBe(SEED)
    }
    expect(liveCspHeaderFor).not.toHaveBeenCalled()
    expect(hasGrantsSync).not.toHaveBeenCalled()
  })

  it('leaves a document from an origin with no grant untouched', async () => {
    served.clear()
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: false }))
    expect(await handler(details({}), SEED)).toBe(SEED)
  })

  it('gives a cache-served origin\'s document in the default session the policy too, when it holds a grant -- a navigation into it commits here before the tab\'s partition swap, and that document must not run with the app\'s grants and no policy', async () => {
    served.add(ORIGIN)
    try {
      liveCspHeaderFor.mockResolvedValueOnce(CSP)
      const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true }))
      const result = await handler(details({}), SEED)
      expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    } finally {
      served.clear()
    }
  })

  it('reads from the ACCUMULATED result, not `details` directly -- it composes with whatever an earlier handler already left', async () => {
    served.clear()
    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true }))
    const current: ResponseHeadersResult = { responseHeaders: { 'x-earlier': ['yes'] } }

    const result = await handler(details({ responseHeaders: { 'x-original': ['ignored'] } }), current)

    expect(result.responseHeaders['x-earlier']).toEqual(['yes'])
    expect(result.responseHeaders['x-original']).toBeUndefined()
    expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
  })

  it('adds the isolation headers when the manifest asks, beside the policy', async () => {
    served.clear()
    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true, isolated: true }))
    const result = await handler(details({}), SEED)
    expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    expect(result.responseHeaders['cross-origin-opener-policy']).toEqual(['same-origin'])
    expect(result.responseHeaders['cross-origin-embedder-policy']).toEqual(['credentialless'])
  })

  it('keeps the policy and skips isolation when the manifest read fails', async () => {
    served.clear()
    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true, manifestFails: true }))
    const result = await handler(details({}), SEED)
    expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    expect(result.responseHeaders['cross-origin-opener-policy']).toBeUndefined()
  })

  // A dedicated/shared worker's top-level script has no resourceType of its
  // own in Electron's webRequest API -- it arrives classified as 'script'
  // or, on some platform/version combinations, 'other' -- so EITHER, from
  // the granted origin, still needs the document's own CSP: that policy is
  // the only thing standing between the worker and running code the
  // manifest's `script-src`/`connect-src` never allowed.
  it('gives a granted origin\'s worker script (classified as script or other) the same policy a document gets', async () => {
    served.clear()
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true }))
    for (const resourceType of ['script', 'other'] as const) {
      liveCspHeaderFor.mockResolvedValueOnce(CSP)
      const result = await handler(details({ resourceType, url: `${ORIGIN}/worker.js` }), SEED)
      expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    }
  })

  // The two isolation headers stay on documents only -- see
  // defaultSessionGrantedOriginCsp's own doc for why.
  it('never adds the isolation headers to a worker script response, even when the manifest asks for isolation', async () => {
    served.clear()
    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true, isolated: true }))
    const result = await handler(details({ resourceType: 'script', url: `${ORIGIN}/worker.js` }), SEED)
    expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
    expect(result.responseHeaders['cross-origin-opener-policy']).toBeUndefined()
    expect(result.responseHeaders['cross-origin-embedder-policy']).toBeUndefined()
  })

  it('gives the trailing-dot spelling of a granted origin the same CSP as the canonical one, reading the grant under the canonical origin', async () => {
    served.clear()
    liveCspHeaderFor.mockResolvedValueOnce(CSP)
    const hasGrantsSync = vi.fn((origin: string) => origin === 'http://localhost:8874')
    const handler = defaultSessionGrantedOriginCsp({ app: { hasGrantsSync, manifest: async () => ({}) } } as unknown as Broker)
    const result = await handler(details({ url: 'http://localhost.:8874/' }), SEED)
    expect(hasGrantsSync).toHaveBeenCalledWith('http://localhost:8874')
    expect(result.responseHeaders['Content-Security-Policy']).toEqual([CSP])
  })

  it('lets a failed CSP read reject -- the owner (../sessions/web-request-owner.ts) is what catches it and passes the response through unmodified, not this function', async () => {
    served.clear()
    liveCspHeaderFor.mockRejectedValueOnce(new Error('broker gone'))
    const handler = defaultSessionGrantedOriginCsp(brokerWith({ hasGrant: true }))
    await expect(handler(details({}), SEED)).rejects.toThrow('broker gone')
  })
})
