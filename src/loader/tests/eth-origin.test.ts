import { describe, expect, it } from 'vitest'
import { servedByVerifier } from '../eth-origin.js'
import { ensurePublicUnicastOrigin } from '../install-origin.js'

describe('servedByVerifier', () => {
  it('is true for an https .eth origin only', () => {
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
