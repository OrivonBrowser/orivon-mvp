// Exercises node-dns.ts's real dns.lookup/dns.promises.lookup over a
// stubbed orivon.net.lookup, the same globalThis.orivon pattern as
// node-fs.test.ts/node-net.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import type { LookupAddress } from '../../contracts/handles.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (
  resolve: (hostname: string) => Promise<readonly LookupAddress[]>
): { calls: string[] } {
  const calls: string[] = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      lookup: async (opts: { hostname: string }) => { calls.push(opts.hostname); return await resolve(opts.hostname) }
    }
  } as unknown as Orivon
  return { calls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

const ROUTER = [{ address: '82.221.103.244', family: 'IPv4' as const }]
const DUAL_STACK = [
  { address: '82.221.103.244', family: 'IPv4' as const },
  { address: '2001:db8::1', family: 'IPv6' as const }
]

describe('dns.lookup -- k-rpc-socket\'s own call shape, dns.lookup(host, cb)', () => {
  it('resolves the first address, family mapped to Node\'s numeric 4/6 convention', async () => {
    installFakeOrivon(async () => ROUTER)
    const { lookup } = await import('../node-dns.js')
    const result = await new Promise<[Error | null, string, number]>((resolve) => {
      lookup('router.bittorrent.com', (error, address, family) => resolve([error, address, family]))
    })
    expect(result).toEqual([null, '82.221.103.244', 4])
  })

  it('passes the hostname through unchanged, doing no second round trip', async () => {
    const { calls } = installFakeOrivon(async () => ROUTER)
    const { lookup } = await import('../node-dns.js')
    await new Promise<void>((resolve) => { lookup('router.bittorrent.com', () => resolve()) })
    expect(calls).toEqual(['router.bittorrent.com'])
  })
})

describe('dns.lookup -- options-object form', () => {
  it('{ all: true } resolves every address orivon.net.lookup gave, in order, never just the first', async () => {
    installFakeOrivon(async () => DUAL_STACK)
    const { lookup } = await import('../node-dns.js')
    const result = await new Promise<[Error | null, Array<{ address: string, family: number }>]>((resolve) => {
      lookup('example.com', { all: true }, (error, addresses) => resolve([error, addresses]))
    })
    expect(result).toEqual([null, [
      { address: '82.221.103.244', family: 4 },
      { address: '2001:db8::1', family: 6 }
    ]])
  })

  it('{ family: 6 } narrows to the IPv6 result from a dual-stack resolution', async () => {
    installFakeOrivon(async () => DUAL_STACK)
    const { lookup } = await import('../node-dns.js')
    const result = await new Promise<[Error | null, string, number]>((resolve) => {
      lookup('example.com', { family: 6 }, (error, address, family) => resolve([error, address, family]))
    })
    expect(result).toEqual([null, '2001:db8::1', 6])
  })
})

// test-the-guards-failure-path + A152: a real denial must surface as
// err.code === 'denied', never a generic 'internal' a ported app cannot
// branch on.
describe('dns.lookup -- failure paths', () => {
  it('a denied resolution (d-0030: hostname outside the app\'s granted network breadth) surfaces err.code === \'denied\'', async () => {
    installFakeOrivon(async () => { throw Object.assign(new Error('host not granted'), { code: 'denied' }) })
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('blocked.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('denied')
  })

  /** Same shape as installFakeOrivon above, plus a stubbed app.grants() -- describeLookupDenial's only other dependency. */
  function installFakeOrivonWithGrants (
    deniedMessage: string,
    grants: Array<{ capability: string }>
  ): void {
    ;(globalThis as GlobalWithOrivon).orivon = {
      net: { lookup: async () => { throw Object.assign(new Error(deniedMessage), { code: 'denied' }) } },
      app: { grants: async () => grants }
    } as unknown as Orivon
  }

  // d-0031/A193: the broker's own 'denied' stays uniform (checked in
  // src/broker/tests/net-lookup.test.ts); this is the shim naming the
  // reason for a ported app, from the app's OWN app.grants() rather than
  // anything the broker's reply says.
  it('names an https.connect-only refusal instead of leaving it a bare denial', async () => {
    installFakeOrivonWithGrants('the hostname was not authorised by any held network grant', [{ capability: 'https.connect' }])
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('blocked.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('denied')
    expect(error.message).toMatch(/https\.connect/)
    expect(error.message).toMatch(/tcp\.connect|udp\.send/)
  })

  it('leaves the denial message generic when the app holds no network grant at all -- nothing to name', async () => {
    installFakeOrivonWithGrants('no grant', [])
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('blocked.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('denied')
    expect(error.message).not.toMatch(/https\.connect/)
  })

  it('leaves the denial message generic when the app also holds tcp.connect -- narrowing must not misname an ordinary pattern-mismatch denial', async () => {
    installFakeOrivonWithGrants('no pattern match', [{ capability: 'https.connect' }, { capability: 'tcp.connect' }])
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('blocked.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('denied')
    expect(error.message).not.toMatch(/https\.connect does not authorise/)
  })

  it('falls back to the generic message, rather than throwing, when app.grants() itself is unavailable', async () => {
    installFakeOrivon(async () => { throw Object.assign(new Error('no grant'), { code: 'denied' }) })
    // No .app at all on this fake orivon -- the pre-existing shape every
    // other test in this file already uses.
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('blocked.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('denied')
  })

  it('an unreachable resolution (a permitted name that resolves nowhere, or only to an address the app could never reach) surfaces the real platformCode, e.g. ENOTFOUND', async () => {
    installFakeOrivon(async () => { throw Object.assign(new Error('no records'), { code: 'unreachable', platformCode: 'ENOTFOUND' }) })
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('nowhere.example', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('ENOTFOUND')
  })

  it('an empty resolved-address array (nothing of the requested family) is ENOTFOUND, not a silently empty success', async () => {
    installFakeOrivon(async () => ROUTER)
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      lookup('router.bittorrent.com', { family: 6 }, (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('ENOTFOUND')
  })
})

describe('dns.promises.lookup', () => {
  it('resolves { address, family } by default', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = await import('../node-dns.js')
    const result = await dns.promises.lookup('router.bittorrent.com')
    expect(result).toEqual({ address: '82.221.103.244', family: 4 })
  })

  it('resolves an array with { all: true }', async () => {
    installFakeOrivon(async () => DUAL_STACK)
    const dns = await import('../node-dns.js')
    const result = await dns.promises.lookup('example.com', { all: true })
    expect(result).toEqual([
      { address: '82.221.103.244', family: 4 },
      { address: '2001:db8::1', family: 6 }
    ])
  })

  it('rejects with err.code === \'denied\' for a denied resolution, matching the callback form', async () => {
    installFakeOrivon(async () => { throw Object.assign(new Error('host not granted'), { code: 'denied' }) })
    const dns = await import('../node-dns.js')
    await expect(dns.promises.lookup('blocked.example')).rejects.toMatchObject({ code: 'denied' })
  })

  it('other dns.promises members are named, not silently absent (A135) -- reading one is safe (A169), only calling it refuses', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = (await import('../node-dns.js')).default as unknown as { promises: Record<string, () => unknown> }
    const { OrivonShimError } = await import('../errors.js')
    expect(() => dns.promises.resolve4).not.toThrow()
    expect(() => dns.promises.resolve4!()).toThrow(OrivonShimError)
  })
})

// A135: every OTHER dns.* member used to be silently absent -- `dns.resolve4`
// read off the default export (the shape a bundled CJS `require('dns')`
// resolves to) threw a bare "resolve4 is not a function".
describe('dns\'s other members -- named refusal instead of absence (A135), reading one is safe (A169)', () => {
  it('throws a named OrivonShimError, reason unimplemented, for resolve4 when called -- reading it off the default export first does not throw', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = (await import('../node-dns.js')).default as unknown as Record<string, () => unknown>
    const { OrivonShimError } = await import('../errors.js')
    expect(() => dns.resolve4).not.toThrow()
    expect(() => dns.resolve4!()).toThrow(OrivonShimError)
    try {
      dns.resolve4!()
    } catch (error) {
      expect((error as InstanceType<typeof OrivonShimError>).api).toBe('dns.resolve4')
      expect((error as InstanceType<typeof OrivonShimError>).reason).toBe('unimplemented')
    }
  })

  it.each(['resolve', 'resolve6', 'reverse', 'setServers'])(
    'names %s the same way when called, not a generic TypeError -- reading it first is safe',
    async (member) => {
      installFakeOrivon(async () => ROUTER)
      const dns = (await import('../node-dns.js')).default as unknown as Record<string, () => unknown>
      const { OrivonShimError } = await import('../errors.js')
      expect(() => dns[member]).not.toThrow()
      expect(() => dns[member]!()).toThrow(OrivonShimError)
    }
  )

  // A169's actual point: a library that merely probes an unbuilt member --
  // `typeof`, optional chaining, destructuring -- must never crash at
  // import just because it checked before calling.
  it('typeof, optional chaining and destructuring over an unbuilt member never throw', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = (await import('../node-dns.js')).default as unknown as Record<string, unknown>
    expect(typeof dns.resolve4).toBe('function')
    expect(() => dns.resolve4 ?? undefined).not.toThrow()
    expect(() => { const { resolve4 } = dns as { resolve4?: unknown }; return resolve4 }).not.toThrow()
  })

  it('still serves the real lookup/promises exports unchanged through the same default export', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = await import('../node-dns.js')
    expect(typeof dns.default.lookup).toBe('function')
    expect(typeof dns.default.promises.lookup).toBe('function')
  })

  it('lets `in` report every other member as truthfully absent, so real feature-detection is not fooled', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = (await import('../node-dns.js')).default as unknown as Record<string, unknown>
    expect('resolve4' in dns).toBe(false)
  })
})

describe('dns.lookup -- answered without a capability call, and Node\'s argument forms', () => {
  it.each([
    ['67.215.246.10', 4],
    ['2001:db8::1', 6]
  ] as const)('returns the literal %s itself, never asking orivon.net.lookup', async (literal, family) => {
    const { calls } = installFakeOrivon(async () => ROUTER)
    const { lookup } = await import('../node-dns.js')
    const result = await new Promise<[Error | null, string, number]>((resolve) => {
      lookup(literal, (error, address, fam) => resolve([error, address, fam]))
    })
    expect(result).toEqual([null, literal, family])
    expect(calls).toHaveLength(0)
  })

  it('answers localhost with loopback, and { all: true } over a literal with a one-entry list', async () => {
    const { calls } = installFakeOrivon(async () => ROUTER)
    const { lookup } = await import('../node-dns.js')
    const local = await new Promise<[string, number]>((resolve) => { lookup('localhost', (_e, address, family) => resolve([address, family])) })
    expect(local).toEqual(['127.0.0.1', 4])
    const all = await new Promise<Array<{ address: string, family: number }>>((resolve) => { lookup('10.0.0.1', { all: true }, (_e, addresses) => resolve(addresses)) })
    expect(all).toEqual([{ address: '10.0.0.1', family: 4 }])
    expect(calls).toHaveLength(0)
  })

  it('takes a bare family number as its options argument', async () => {
    installFakeOrivon(async () => DUAL_STACK)
    const { lookup } = await import('../node-dns.js')
    const result = await new Promise<[string, number]>((resolve) => { lookup('example.com', 6, (_e, address, family) => resolve([address, family])) })
    expect(result).toEqual(['2001:db8::1', 6])
  })

  it('a name that resolves nowhere fails like Node\'s getaddrinfo: ENOTFOUND, errno, syscall and hostname', async () => {
    installFakeOrivon(async () => [])
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error | null>((resolve) => { lookup('nowhere.example', (e) => resolve(e)) })
    expect(error).toMatchObject({ code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'nowhere.example', message: 'getaddrinfo ENOTFOUND nowhere.example' })
  })

  it('an unreachable resolution with no platformCode still reads as ENOTFOUND', async () => {
    installFakeOrivon(async () => { throw Object.assign(new Error('no records'), { code: 'unreachable' }) })
    const { lookup } = await import('../node-dns.js')
    const error = await new Promise<Error | null>((resolve) => { lookup('nowhere.example', (e) => resolve(e)) })
    expect(error).toMatchObject({ code: 'ENOTFOUND', hostname: 'nowhere.example' })
  })
})

describe('dns/promises', () => {
  it('exports the same lookup as dns.promises, named and default', async () => {
    installFakeOrivon(async () => ROUTER)
    const dns = await import('../node-dns.js')
    const dnsPromises = await import('../node-dns-promises.js')
    expect(dnsPromises.lookup).toBe(dns.promises.lookup)
    expect(dnsPromises.default).toBe(dns.promises)
    expect(await dnsPromises.lookup('router.bittorrent.com')).toEqual({ address: '82.221.103.244', family: 4 })
    expect(await dnsPromises.lookup('::1')).toEqual({ address: '::1', family: 6 })
  })
})
