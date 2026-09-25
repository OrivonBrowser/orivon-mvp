import { describe, expect, it, vi } from 'vitest'
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails } from 'electron'

const onHeadersReceived = vi.fn()
const fromPartition = vi.fn(() => ({ webRequest: { onHeadersReceived } }))
vi.mock('electron', () => ({ session: { fromPartition } }))

const { grantedOriginCspListener, installGrantedOriginCsp, withAppendedCsp } = await import('../granted-origin-csp.js')
const { partitionFor } = await import('../../../broker/grants/origin-hash.js')

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

async function run (listener: ReturnType<typeof grantedOriginCspListener>, input: OnHeadersReceivedListenerDetails): Promise<HeadersReceivedResponse> {
  return await new Promise((resolve) => { listener(input, resolve) })
}

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

describe('grantedOriginCspListener', () => {
  it('gives a document from the granted origin the installed path\'s policy, built fresh per response', async () => {
    let csp = CSP
    const listener = grantedOriginCspListener(ORIGIN, async () => csp)

    const first = await run(listener, details({}))
    expect(first.responseHeaders?.['Content-Security-Policy']).toEqual([CSP])

    csp = "default-src 'none'"
    const second = await run(listener, details({ resourceType: 'subFrame', url: `${ORIGIN}/frame.html` }))
    expect(second.responseHeaders?.['Content-Security-Policy']).toEqual(["default-src 'none'"])
  })

  it('leaves every non-document response untouched', async () => {
    const cspFor = vi.fn(async () => CSP)
    const listener = grantedOriginCspListener(ORIGIN, cspFor)
    for (const resourceType of ['script', 'xhr', 'image', 'stylesheet', 'other'] as const) {
      expect(await run(listener, details({ resourceType, url: `${ORIGIN}/app.js` }))).toEqual({})
    }
    expect(cspFor).not.toHaveBeenCalled()
  })

  it('leaves a document from any other origin untouched', async () => {
    const listener = grantedOriginCspListener(ORIGIN, async () => CSP)
    expect(await run(listener, details({ url: 'http://127.0.0.1:9999/' }))).toEqual({})
    expect(await run(listener, details({ resourceType: 'subFrame', url: 'https://example.com/' }))).toEqual({})
  })

  it('answers without a policy rather than hanging the response when the grant read fails', async () => {
    const listener = grantedOriginCspListener(ORIGIN, async () => { throw new Error('broker gone') })
    expect(await run(listener, details({}))).toEqual({})
  })
})

describe('installGrantedOriginCsp', () => {
  it('installs one listener on the granted origin\'s own app partition, building the installed path\'s policy from the live grants', async () => {
    const grants = [{ id: 'g1', origin: ORIGIN, grantedAt: 0, capability: 'https.connect', patterns: ['api.example.com:443'] }]
    installGrantedOriginCsp({ app: { grants: async () => grants } } as never, ORIGIN)
    expect(fromPartition).toHaveBeenCalledWith(partitionFor(ORIGIN))
    expect(onHeadersReceived).toHaveBeenCalledTimes(1)

    const listener = onHeadersReceived.mock.calls[0]?.[0] as ReturnType<typeof grantedOriginCspListener>
    const response = await run(listener, details({}))
    const csp = response.responseHeaders?.['Content-Security-Policy']?.[0] ?? ''
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'")
    expect(csp).toContain("connect-src 'self' data: blob: https://api.example.com:443")
  })
})
