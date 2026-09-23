import { describe, expect, it, vi } from 'vitest'
import { checkConnect } from '../connect.js'
import type { Resolver } from '../connect.js'
import { checkLookup } from '../lookup.js'

// A connect pattern whose host is exactly `localhost` names the loopback
// literals at that port -- the same authority as granting `127.0.0.1:p` and
// `[::1]:p` -- and `localhost` itself is never resolved. Every other
// hostname pattern still never authorises a private address (T12).

const unresolvable: Resolver = async () => { throw new Error('localhost and literals must never reach the resolver') }

describe('a localhost pattern', () => {
  it('connect("localhost") is answered with both loopback literals, without DNS', async () => {
    const resolve = vi.fn(unresolvable)
    const decision = await checkConnect(['localhost:8080'], 'localhost', 8080, resolve)

    expect(decision).toEqual({ allowed: true, addresses: ['127.0.0.1', '::1'] })
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['127.0.0.1', '::1', '[::1]'])('authorises the loopback literal %s at that port', async (host) => {
    const decision = await checkConnect(['localhost:8080'], host, 8080, unresolvable)
    expect(decision.allowed).toBe(true)
  })

  it.each<[string, number]>([['localhost', 9090], ['127.0.0.2', 8080], ['10.0.0.1', 8080]])(
    'authorises nothing else: %s:%d', async (host, port) => {
      const decision = await checkConnect(['localhost:8080'], host, port, unresolvable)
      expect(decision.allowed).toBe(false)
    }
  )

  it('never authorises a different name that resolves to loopback -- the rebinding attack', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1'])

    const alone = await checkConnect(['localhost:8080'], 'evil.example', 8080, resolve)
    const withTheName = await checkConnect(['localhost:8080', 'evil.example:8080'], 'evil.example', 8080, resolve)

    expect(alone.allowed === false && alone.reason).toBe('no-pattern-possible')
    expect(withTheName.allowed).toBe(false)
  })

  it('a .localhost subdomain pattern is an ordinary hostname, and never reaches loopback', async () => {
    const decision = await checkConnect(['app.localhost:8080'], 'app.localhost', 8080, async () => ['127.0.0.1'])
    expect(decision.allowed).toBe(false)
  })
})

describe('connect("localhost") under other grants', () => {
  it('a wildcard grant still never reaches loopback, and resolves nothing to find that out', async () => {
    const resolve = vi.fn(unresolvable)
    const decision = await checkConnect(['*:*'], 'localhost', 8080, resolve)

    expect(decision.allowed).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a single loopback literal grant dials just that literal', async () => {
    const decision = await checkConnect(['127.0.0.1:8080'], 'localhost', 8080, unresolvable)
    expect(decision).toEqual({ allowed: true, addresses: ['127.0.0.1'] })
  })
})

describe('lookup("localhost")', () => {
  it('answers loopback, without DNS, under a localhost pattern', () => {
    expect(checkLookup(['localhost:8080'], 'localhost')).toEqual({
      allowed: true,
      hostname: 'localhost',
      answers: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }]
    })
  })

  it('carries no loopback answer under a wildcard, which cannot reach loopback anyway', () => {
    expect(checkLookup(['*:*'], 'localhost')).toEqual({ allowed: true, hostname: 'localhost' })
  })
})
