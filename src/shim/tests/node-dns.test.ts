import { describe, expect, it } from 'vitest'
import { lookup, OrivonDnsUnsupportedError } from '../node-dns.js'
import dns from '../node-dns.js'
import { OrivonShimError } from '../errors.js'

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

// A135: every OTHER dns.* member used to be silently absent -- `dns.resolve4`
// read off the default export (the shape a bundled CJS `require('dns')`
// resolves to) threw a bare "resolve4 is not a function", same as calling it.
describe('dns\'s other members -- named refusal instead of absence (A135)', () => {
  it('throws a named OrivonShimError, reason not-built, for resolve4 -- read off the default export, before it is even called', () => {
    expect(() => (dns as unknown as Record<string, unknown>).resolve4).toThrow(OrivonShimError)
    try {
      void (dns as unknown as Record<string, unknown>).resolve4
    } catch (error) {
      expect((error as OrivonShimError).api).toBe('dns.resolve4')
      expect((error as OrivonShimError).reason).toBe('not-built')
      expect((error as OrivonShimError).message).toMatch(/D-0006/)
    }
  })

  it.each(['resolve', 'resolve6', 'reverse', 'setServers', 'promises'])(
    'names %s the same way, not a generic TypeError',
    (member) => {
      expect(() => (dns as unknown as Record<string, unknown>)[member]).toThrow(OrivonShimError)
    }
  )

  it('still serves the real lookup export unchanged through the same default export', () => {
    expect(typeof dns.lookup).toBe('function')
  })

  it('lets `in` report every other member as truthfully absent, so real feature-detection is not fooled', () => {
    expect('resolve4' in (dns as unknown as Record<string, unknown>)).toBe(false)
  })
})
