import { describe, expect, it } from 'vitest'
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails } from 'electron'
import { vi } from 'vitest'

const onHeadersReceived = vi.fn()
const fromPartition = vi.fn(() => ({ webRequest: { onHeadersReceived } }))
vi.mock('electron', () => ({ session: { fromPartition } }))

const { grantedOriginCspListener, withIsolationHeaders } = await import('../granted-origin-csp.js')

// An origin granted without installing gets the isolation headers its
// manifest asks for on its documents, through the same onHeadersReceived
// listener that appends the CSP -- read per response, so a manifest change
// reaches the next load. The server's own weaker values are replaced, not
// kept beside: two COOP values do not intersect the way two CSPs do.

const ORIGIN = 'http://127.0.0.1:8874'
const CSP = "default-src 'self'"

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

describe('withIsolationHeaders', () => {
  it('adds both headers and keeps everything else', () => {
    expect(withIsolationHeaders({ 'Content-Type': ['text/html'] })).toEqual({
      'Content-Type': ['text/html'],
      'cross-origin-opener-policy': ['same-origin'],
      'cross-origin-embedder-policy': ['credentialless']
    })
  })

  it('replaces the server\'s own values, under any spelling', () => {
    expect(withIsolationHeaders({ 'Cross-Origin-Opener-Policy': ['unsafe-none'], 'Cross-Origin-Embedder-Policy': ['unsafe-none'] })).toEqual({
      'cross-origin-opener-policy': ['same-origin'],
      'cross-origin-embedder-policy': ['credentialless']
    })
  })
})

describe('grantedOriginCspListener -- isolation', () => {
  it('adds the isolation headers to a document when the manifest asks, beside the policy', async () => {
    const listener = grantedOriginCspListener(ORIGIN, async () => CSP, async () => true)
    const result = await run(listener, details({}))
    expect(result.responseHeaders?.['Content-Security-Policy']).toEqual([CSP])
    expect(result.responseHeaders?.['cross-origin-opener-policy']).toEqual(['same-origin'])
    expect(result.responseHeaders?.['cross-origin-embedder-policy']).toEqual(['credentialless'])
  })

  it('adds only the policy when the manifest does not ask, and by default', async () => {
    const explicit = await run(grantedOriginCspListener(ORIGIN, async () => CSP, async () => false), details({}))
    expect(explicit.responseHeaders).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': [CSP] })
    const byDefault = await run(grantedOriginCspListener(ORIGIN, async () => CSP), details({}))
    expect(byDefault.responseHeaders).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': [CSP] })
  })

  it('reads the manifest\'s answer per response, so a change reaches the next load', async () => {
    let isolated = false
    const listener = grantedOriginCspListener(ORIGIN, async () => CSP, async () => isolated)
    expect((await run(listener, details({}))).responseHeaders?.['cross-origin-opener-policy']).toBeUndefined()
    isolated = true
    expect((await run(listener, details({}))).responseHeaders?.['cross-origin-opener-policy']).toEqual(['same-origin'])
  })

  it('keeps the policy and skips isolation when the manifest read fails', async () => {
    const listener = grantedOriginCspListener(ORIGIN, async () => CSP, async () => { throw new Error('unregistered') })
    expect(await run(listener, details({}))).toEqual({ responseHeaders: { 'Content-Type': ['text/html'], 'Content-Security-Policy': [CSP] } })
  })
})
