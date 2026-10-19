// connectSecure's TLS options at the broker level, over a stub `dialSecure`:
// what reaches the dial, and -- the security property -- that an option which
// stops the certificate binding the granted name sends the call through the
// resolve-once address check (security-model.md T12) instead of widening what
// the grant reaches. Real handshakes are ./net-connect-secure-e2e.test.ts's
// and ../adapters/tests/tls-adapter-options.test.ts's job.

import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okSecureSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions, DialSecure, SecureDialOptions, SecureDialTarget } from '../broker-contracts.js'
import type { SecureConnectOptions } from '../../contracts/index.js'

interface DialCall { readonly target: SecureDialTarget, readonly options: SecureDialOptions }

async function grantedBroker (patterns: readonly string[], deps: Partial<CreateBrokerOptions> = {}): Promise<{ broker: Broker, calls: DialCall[] }> {
  const calls: DialCall[] = []
  const dialSecure: DialSecure = async (target, options) => {
    calls.push({ target, options })
    return okSecureSocket()
  }
  const broker = createBroker(baseDeps({ dialSecure, ...deps }))
  broker.registerApp(APP, manifestWith({ net: { https: { connect: patterns } } }))
  await broker.grant(APP, 'https.connect', patterns)
  return { broker, calls }
}

const resolvesTo = (answers: readonly string[]): CreateBrokerOptions['resolve'] => vi.fn(async () => answers)

describe('options reach the dial unchanged', () => {
  it('passes every TLS option through, and hands the handshake facts back on the socket', async () => {
    const facts = { authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', alpnProtocol: 'h2' as const, peerCertificate: null }
    const calls: DialCall[] = []
    const { broker } = await grantedBroker(['electrum.example:50002'], {
      resolve: resolvesTo(['93.184.216.34']),
      dialSecure: async (target, options) => { calls.push({ target, options }); return okSecureSocket(facts) }
    })
    const pfx = new Uint8Array([1, 2, 3])
    const options = {
      rejectUnauthorized: false,
      ca: ['CA-PEM'],
      cert: 'CERT-PEM',
      key: 'KEY-PEM',
      pfx,
      passphrase: 'secret',
      servername: 'electrum.example',
      alpnProtocols: ['h2', 'http/1.1']
    }

    const socket = await broker.net.connectSecure(APP, { host: 'electrum.example', port: 50002, ...options })

    expect(calls[0]?.options).toEqual(options)
    expect(socket).toMatchObject(facts)
  })

  it('with no options, resolves the checked name through the injected resolver and dials its answers under the name: the default certificate check binds it', async () => {
    const resolve = resolvesTo(['203.0.113.7', '2001:db8::7'])
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve })

    await broker.net.connectSecure(APP, { host: 'API.example.com', port: 443 })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('api.example.com')
    expect(calls[0]?.target).toEqual({ host: 'api.example.com', port: 443, addresses: ['203.0.113.7', '2001:db8::7'] })
    expect(calls[0]?.options.servername).toBeUndefined()
  })

  it('does not apply the address check to a name-bound dial: the name and the certificate are the authorisation', async () => {
    const resolve = resolvesTo(['10.0.0.5'])
    const { broker, calls } = await grantedBroker(['intranet.example.com:443'], { resolve })

    await broker.net.connectSecure(APP, { host: 'intranet.example.com', port: 443 })

    expect(calls[0]?.target.addresses).toEqual(['10.0.0.5'])
  })

  it('a resolver failure on a name-bound dial is unreachable with its real code, and nothing is dialled', async () => {
    const resolve: CreateBrokerOptions['resolve'] = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) }
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve })

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ENOTFOUND')
    expect(calls).toEqual([])
  })

  it('asks T20 before resolving anything', async () => {
    const resolve = resolvesTo(['203.0.113.7'])
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve, proxyConfigured: async () => true })

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('denied')
    expect(resolve).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it.each([
    ['servername equal to the host', { servername: 'API.Example.com' }],
    ['servername "" (no SNI, verified against the host)', { servername: '' }],
    ['rejectUnauthorized: true', { rejectUnauthorized: true }],
    ['a client certificate and ALPN', { cert: 'C', key: 'K', alpnProtocols: ['h2'] }]
  ])('%s keeps the name-bound path', async (_label, extra) => {
    const resolve = resolvesTo(['93.184.216.34'])
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve })

    await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443, ...extra })

    expect(calls[0]?.target).toEqual({ host: 'api.example.com', port: 443, addresses: ['93.184.216.34'] })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe('an option that unbinds the name sends the call through the resolve-once address check', () => {
  it.each([
    ['rejectUnauthorized: false', { rejectUnauthorized: false }],
    ['its own ca', { ca: 'PEM' }],
    ['a servername other than the host', { servername: 'other.example.com' }]
  ])('%s: resolves once and dials the checked literals, keeping the name for SNI and verification', async (_label, extra) => {
    const resolve = resolvesTo(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve })

    await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443, ...extra })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(calls[0]?.target).toEqual({
      host: 'api.example.com',
      port: 443,
      addresses: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']
    })
  })

  it.each([
    ['a wildcard grant', ['*:443']],
    ['a grant naming the host itself', ['rebind.example:443']]
  ])('denies a name that resolves to a private address under %s, and never dials', async (_label, patterns) => {
    for (const privateAnswer of ['127.0.0.1', '192.168.1.1', '169.254.169.254']) {
      const { broker, calls } = await grantedBroker(patterns, { resolve: resolvesTo(['93.184.216.34', privateAnswer]) })

      const error = await rejection(broker.net.connectSecure(APP, { host: 'rebind.example', port: 443, rejectUnauthorized: false }))

      expect(error.code).toBe('denied')
      expect(error.platformCode).toBeUndefined()
      expect(calls).toHaveLength(0)
    }
  })

  it('still reaches an address the grant names literally -- a LAN node the person approved', async () => {
    const { broker, calls } = await grantedBroker(['192.168.1.10:50002'])

    await broker.net.connectSecure(APP, { host: '192.168.1.10', port: 50002, rejectUnauthorized: false })

    expect(calls[0]?.target).toEqual({ host: '192.168.1.10', port: 50002, addresses: ['192.168.1.10'] })
  })

  it('reaches loopback under a localhost grant without resolving', async () => {
    const resolve = resolvesTo([])
    const { broker, calls } = await grantedBroker(['localhost:10009'], { resolve })

    await broker.net.connectSecure(APP, { host: 'localhost', port: 10009, rejectUnauthorized: false })

    expect(resolve).not.toHaveBeenCalled()
    expect(calls[0]?.target.addresses?.length).toBeGreaterThan(0)
    expect(calls[0]?.target.addresses?.every((address) => address === '127.0.0.1' || address === '::1')).toBe(true)
  })

  it('a resolver failure is unreachable with its real code, never a denial', async () => {
    const resolve: CreateBrokerOptions['resolve'] = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) }
    const { broker } = await grantedBroker(['api.example.com:443'], { resolve })

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443, rejectUnauthorized: false }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ENOTFOUND')
  })
})

describe('servername never widens what a grant reaches', () => {
  it('denies a host the grant does not name even when servername names a granted host', async () => {
    const { broker, calls } = await grantedBroker(['api.example.com:443'], { resolve: resolvesTo(['93.184.216.34']) })
    const opts: SecureConnectOptions = { host: 'evil.example.com', port: 443, servername: 'api.example.com' }

    const error = await rejection(broker.net.connectSecure(APP, opts))

    expect(error.code).toBe('denied')
    expect(calls).toHaveLength(0)
  })
})

describe('a replacement grant re-checks a live unbound socket by the address it reached', () => {
  it('keeps a socket whose reached address the new grant still covers, and closes one it no longer does', async () => {
    const { broker } = await grantedBroker(['api.example.com:443', '192.168.1.10:443'], { resolve: resolvesTo(['93.184.216.34']) })
    const kept = await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443, rejectUnauthorized: false })
    const dropped = await broker.net.connectSecure(APP, { host: '192.168.1.10', port: 443, rejectUnauthorized: false })
    let keptClosed = false
    kept.closed.then(() => { keptClosed = true }, () => { keptClosed = true })

    await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    expect((await rejection(dropped.closed)).code).toBe('revoked')
    expect(keptClosed).toBe(false)
  })
})
