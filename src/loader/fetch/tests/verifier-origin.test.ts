import { describe, expect, it } from 'vitest'
import { servedByVerifier } from '../verifier-origin.js'
import { ensurePublicUnicastOrigin } from '../install-origin.js'

describe('servedByVerifier', () => {
  it('is true for an https origin a protocol serves only', () => {
    expect(servedByVerifier('https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon/')).toBe(true)
    expect(servedByVerifier('https://ipfs.orivon/Qm')).toBe(true)
    expect(servedByVerifier('https://orivon')).toBe(false)
    expect(servedByVerifier('https://vitalik.eth')).toBe(true)
    expect(servedByVerifier('https://app.ens.eth/path')).toBe(true)
    expect(servedByVerifier('http://freetube.eth')).toBe(false)
    expect(servedByVerifier('https://eth.example.com')).toBe(false)
    expect(servedByVerifier('https://example.eth.com')).toBe(false)
    expect(servedByVerifier('not a url')).toBe(false)
  })
})

describe('ensurePublicUnicastOrigin for a .eth origin', () => {
  it('passes without resolving anything, and hands on no address', async () => {
    let asked = 0
    const result = await ensurePublicUnicastOrigin('https://vitalik.eth', async () => { asked++; return ['127.0.0.1'] })
    expect(result).toEqual({ ok: true, addresses: [] })
    expect(asked).toBe(0)
  })

  it('still refuses a developer name over plain http', async () => {
    expect((await ensurePublicUnicastOrigin('http://freetube.eth', async () => ['127.0.0.1'])).ok).toBe(false)
  })
})

describe('ensurePublicUnicastOrigin while the whole browser is on the tunnel', () => {
  const farEnd = (resolve: (host: string) => Promise<string[]>, atFarEnd: (origin: string) => boolean) => Object.assign(resolve, { atFarEnd })

  it('resolves no name here, since the far end resolves it, and hands on no address', async () => {
    let asked = 0
    const resolver = farEnd(async () => { asked++; return ['127.0.0.1'] }, () => true)
    expect(await ensurePublicUnicastOrigin('https://app.example', resolver)).toEqual({ ok: true, addresses: [] })
    expect(asked).toBe(0)
  })

  it('still refuses a literal that is not public, a plain-http origin and a .localhost name', async () => {
    const resolver = farEnd(async () => [], () => true)
    for (const origin of ['https://127.0.0.1', 'https://10.0.0.8', 'http://app.example', 'https://app.localhost']) expect((await ensurePublicUnicastOrigin(origin, resolver)).ok, origin).toBe(false)
  })

  it('resolves as it always did for an origin the tunnel does not carry', async () => {
    const resolver = farEnd(async () => ['93.184.216.34'], () => false)
    expect(await ensurePublicUnicastOrigin('https://app.example', resolver)).toEqual({ ok: true, addresses: ['93.184.216.34'] })
  })
})
