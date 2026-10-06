import { beforeEach, describe, expect, it, vi } from 'vitest'
import { holdForVerifier, namesVerifiedHost, prewarmVerifier, provideVerifierAccess } from '../verifier-access.js'

describe('namesVerifiedHost', () => {
  it('is true for a .eth name typed bare, with a scheme, a port, a path or a query', () => {
    for (const typed of ['vitalik.eth', 'Vitalik.ETH', 'vitalik.eth/blog', 'https://vitalik.eth', 'https://app.vitalik.eth:8443/x?y=1#z', 'vitalik.eth?x', '  vitalik.eth  ']) {
      expect(namesVerifiedHost(typed), typed).toBe(true)
    }
  })

  it('is true for an ipfs address and for a scheme-address host', () => {
    expect(namesVerifiedHost('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/')).toBe(true)
    expect(namesVerifiedHost('https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon/')).toBe(true)
  })

  it('is false for a search, a site, a partial name and an empty box', () => {
    for (const typed of ['', '   ', 'cats', 'what is vitalik.eth', 'example.com', 'vitalik.e', 'https://example.com/vitalik.eth', 'eth', 'user@example.com', 'localhost:3000']) {
      expect(namesVerifiedHost(typed), typed).toBe(false)
    }
  })
})

describe('prewarmVerifier', () => {
  const start = vi.fn()
  beforeEach(() => {
    start.mockClear()
    provideVerifierAccess({ start, ready: async () => {} })
  })

  it('starts the host when the typed text names a .eth host', () => {
    prewarmVerifier('vitalik.eth')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('leaves the host alone for anything else', () => {
    prewarmVerifier('weather in rome')
    prewarmVerifier('example.com')
    expect(start).not.toHaveBeenCalled()
  })
})

describe('holdForVerifier', () => {
  it('starts the host and waits for it for a verifier-served url only', async () => {
    const start = vi.fn()
    const ready = vi.fn(async () => {})
    provideVerifierAccess({ start, ready })
    await holdForVerifier('https://example.com/')
    await holdForVerifier('not a url')
    expect(start).not.toHaveBeenCalled()
    await holdForVerifier('https://vitalik.eth/x')
    expect(start).toHaveBeenCalledTimes(1)
    expect(ready).toHaveBeenCalledTimes(1)
  })
})

describe('verifierServesName', () => {
  it('is false until something provides servesName, and then asks it', async () => {
    vi.resetModules()
    const fresh = await import('../verifier-access.js')
    expect(fresh.verifierServesName('vitalik.eth')).toBe(false)
    fresh.provideVerifierAccess({ start: () => {}, ready: async () => {} })
    expect(fresh.verifierServesName('vitalik.eth')).toBe(false)
    fresh.provideVerifierAccess({ start: () => {}, ready: async () => {}, servesName: (name) => name === 'vitalik.eth' })
    expect(fresh.verifierServesName('vitalik.eth')).toBe(true)
    expect(fresh.verifierServesName('other.eth')).toBe(false)
  })
})
