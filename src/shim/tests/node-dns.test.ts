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
