import { describe, expect, it } from 'vitest'
import { lookup, OrivonDnsUnsupportedError } from '../node-dns.js'

describe('dns.lookup', () => {
  it('fails asynchronously with a named, closed error -- never a synchronous throw', async () => {
    const result = await new Promise<[Error | null, string, number]>((resolve) => {
      lookup('router.bittorrent.com', (error, address, family) => resolve([error, address, family]))
    })
    const [error, address, family] = result
    expect(error).toBeInstanceOf(OrivonDnsUnsupportedError)
    expect((error as OrivonDnsUnsupportedError).code).toBe('ERR_ORIVON_DNS_UNSUPPORTED')
    expect(address).toBe('')
    expect(family).toBe(0)
  })

  it('accepts the options-object form -- lookup(hostname, options, callback)', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      lookup('router.bittorrent.com', { family: 4 }, (err) => resolve(err))
    })
    expect(error).toBeInstanceOf(OrivonDnsUnsupportedError)
  })
})
