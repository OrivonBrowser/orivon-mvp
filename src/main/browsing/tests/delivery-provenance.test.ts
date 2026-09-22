import { describe, expect, it, vi } from 'vitest'

// deliveryProvenanceFor closes over loader/electron-serve.ts's
// isOriginServedFromCache, which itself dynamically imports 'electron' --
// mocked here the same way electron-serve.test.ts mocks it for
// isOriginServedFromCache's own tests, so this suite never needs a real
// Electron session either.

describe('deliveryProvenanceFor -- the address bar\'s S4-6 provenance signal', () => {
  it('reports servedFromPinnedCache: true for an origin whose scheme is actually registered', async () => {
    const handled = new Set<string>(['https'])
    const session = { protocol: { isProtocolHandled: (scheme: string) => handled.has(scheme) } }
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { deliveryProvenanceFor } = await import('../delivery-provenance.js')

    expect(await deliveryProvenanceFor('https://app.example/some/page')).toEqual({ servedFromPinnedCache: true })

    vi.doUnmock('electron')
  })

  it('reports false for an ordinary website nothing has registered serving for', async () => {
    const session = { protocol: { isProtocolHandled: () => false } }
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { deliveryProvenanceFor } = await import('../delivery-provenance.js')

    expect(await deliveryProvenanceFor('https://an-ordinary-website.example/')).toEqual({ servedFromPinnedCache: false })

    vi.doUnmock('electron')
  })

  it('reports false, never throws, for a url with no derivable origin (about:blank, the dashboard)', async () => {
    const { deliveryProvenanceFor } = await import('../delivery-provenance.js')

    expect(await deliveryProvenanceFor('about:blank')).toEqual({ servedFromPinnedCache: false })
  })
})
