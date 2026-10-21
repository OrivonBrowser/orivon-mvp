// A routed app's TCP paths at the assembly layer: connect, connectSecure and
// lookup go through the app's route, never resolve a name on this machine,
// never ask T20, and keep every grant and address check an unrouted app has.
// An app with no route keeps the direct path.

import { createServer as createTlsServer } from 'node:tls'
import type { Server as TlsServer } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, okSecureSocket, okSocket } from './index.test-helpers.js'
import { echoServer, recordedRoute, registerAndGrant, routedBroker } from './net-route.test-helpers.js'
import type { EchoServer } from './net-route.test-helpers.js'
import { createBroker } from '../index.js'
import type { DialedSecureSocket, DialedSocket } from '../broker-contracts.js'
import type { LookupAddress } from '../../contracts/index.js'
import { baseDeps, manifestWith } from './index.test-helpers.js'
import { generateTlsFixture } from '../adapters/tests/tls-adapter.test-helpers.js'

const OTHER_APP = 'https://other.example'
const servers: EchoServer[] = []
afterEach(async () => { while (servers.length > 0) await servers.pop()?.close() })
async function target (): Promise<EchoServer> {
  const server = await echoServer()
  servers.push(server)
  return server
}

/** Deps that fail the test if the broker resolves, dials or probes a proxy on this machine. */
function noLocalNetwork () {
  return {
    resolve: vi.fn(async (): Promise<readonly string[]> => { throw new Error('resolved locally') }),
    resolveLookup: vi.fn(async (): Promise<readonly LookupAddress[]> => { throw new Error('looked up locally') }),
    dial: vi.fn(async (): Promise<DialedSocket> => { throw new Error('dialled directly') }),
    dialSecure: vi.fn(async (): Promise<DialedSecureSocket> => { throw new Error('dialled directly') }),
    proxyConfigured: vi.fn(async () => true)
  }
}

describe('orivon.net.connect for a routed app', () => {
  it('hands the route the name unresolved, and never resolves, dials or probes T20 locally', async () => {
    const echo = await target()
    const { route, connects } = recordedRoute({ target: echo.port })
    const deps = noLocalNetwork()
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { connect: ['onion-like.example:443'] } } }, [['tcp.connect', ['onion-like.example:443']]])

    const socket = await broker.net.connect(APP, { host: 'onion-like.example', port: 443 })

    expect(connects).toEqual([{ host: 'onion-like.example', port: 443 }])
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.dial).not.toHaveBeenCalled()
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
    expect(socket.remoteAddress).toBe('onion-like.example')
    expect(socket.remotePort).toBe(443)

    await socket.writable.getWriter().write(new Uint8Array([104, 105]))
    const reply = await socket.readable.getReader().read()
    expect(Buffer.from(reply.value ?? []).toString()).toBe('hi')
    await socket.close()
  })

  it('still matches the grant by name: a name no pattern names never reaches the route', async () => {
    const { route, connects } = recordedRoute({ target: 1 })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['allowed.example:443'] } } }, [['tcp.connect', ['allowed.example:443']]])

    const error = await rejection(broker.net.connect(APP, { host: 'other.example', port: 443 }))

    expect(error.code).toBe('denied')
    expect(connects).toEqual([])
  })

  it('passes an address literal the grant names to the route as that literal', async () => {
    const echo = await target()
    const { route, connects } = recordedRoute({ target: echo.port })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['93.184.216.34:443'] } } }, [['tcp.connect', ['93.184.216.34:443']]])

    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })

    expect(connects).toEqual([{ host: '93.184.216.34', port: 443 }])
    await socket.close()
  })

  it('keeps the address check for a literal: a private address under a wildcard grant is denied', async () => {
    const { route, connects } = recordedRoute({ target: 1 })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['*:*'] } } }, [['tcp.connect', ['*:*']]])

    for (const host of ['192.168.1.1', '10.0.0.5', '127.0.0.1', '169.254.169.254']) {
      const error = await rejection(broker.net.connect(APP, { host, port: 8080 }))
      expect(error.code, host).toBe('denied')
    }
    expect(connects).toEqual([])
  })

  it('reaches this machine directly, as the address it checked, and never through the route', async () => {
    const { route, connects } = recordedRoute({ target: 1 })
    const deps = { ...noLocalNetwork(), dial: vi.fn(async () => okSocket()) }
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { connect: ['127.0.0.1:8080', 'localhost:9090'] } } }, [['tcp.connect', ['127.0.0.1:8080', 'localhost:9090']]])

    await broker.net.connect(APP, { host: '127.0.0.1', port: 8080 })
    await broker.net.connect(APP, { host: 'localhost', port: 9090 })

    expect(connects).toEqual([])
    expect(deps.dial).toHaveBeenNthCalledWith(1, ['127.0.0.1'], 8080, expect.anything())
    expect(deps.dial).toHaveBeenNthCalledWith(2, ['127.0.0.1', '::1'], 9090, expect.anything())
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
  })

  it('maps any error from the route to unreachable, without the proxy\'s own words', async () => {
    for (const thrown of [new Error('SOCKS5 proxy rejected connection - HostUnreachable at 10.9.9.9'), Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]) {
      const { route } = recordedRoute({ connect: async () => { throw thrown } })
      const broker = routedBroker(route, noLocalNetwork())
      await registerAndGrant(broker, { net: { tcp: { connect: ['a.example:443'] } } }, [['tcp.connect', ['a.example:443']]])

      const error = await rejection(broker.net.connect(APP, { host: 'a.example', port: 443 }))

      expect(error.code).toBe('unreachable')
      expect(error.message).not.toContain('10.9.9.9')
    }
  })

  it('does not fall back to a direct dial when the route fails', async () => {
    const { route } = recordedRoute({ connect: async () => { throw new Error('proxy down') } })
    const deps = { ...noLocalNetwork(), dial: vi.fn(async () => okSocket()) }
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { connect: ['a.example:443'] } } }, [['tcp.connect', ['a.example:443']]])

    await rejection(broker.net.connect(APP, { host: 'a.example', port: 443 }))

    expect(deps.dial).not.toHaveBeenCalled()
  })

  it('is closed with the grant: revoking tcp.connect ends the routed socket', async () => {
    const echo = await target()
    const { route } = recordedRoute({ target: echo.port })
    const broker = routedBroker(route, noLocalNetwork())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['a.example:443'] } } }))
    const grant = await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const socket = await broker.net.connect(APP, { host: 'a.example', port: 443 })

    await broker.revoke(APP, grant.id)

    await expect(socket.closed).rejects.toMatchObject({ code: 'revoked' })
  })

  it('leaves an app with no route on the direct path, T20 included', async () => {
    const echo = await target()
    const { route } = recordedRoute({ target: echo.port })
    const dial = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ routeFor: (key) => key === OTHER_APP ? route : undefined, dial, proxyConfigured: async () => true }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))

    expect(error.code).toBe('denied')
    expect(dial).not.toHaveBeenCalled()
  })

  it('dials directly for an unrouted app when no proxy is configured', async () => {
    const dial = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ routeFor: () => undefined, dial, resolve: async () => ['93.184.216.34'] }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['example.org:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['example.org:443'])

    await broker.net.connect(APP, { host: 'example.org', port: 443 })

    expect(dial).toHaveBeenCalledOnce()
  })
})

describe('orivon.net.connectSecure for a routed app', () => {
  let server: TlsServer
  let port: number
  let caCert: string

  beforeAll(async () => {
    const fixture = generateTlsFixture('secure.example')
    caCert = fixture.caCert
    server = createTlsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (socket) => { socket.on('error', () => {}); socket.end('hello over the route') })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })

  it('runs the handshake over the route against the name, with no local resolve', async () => {
    const { route, connects } = recordedRoute({ target: port })
    const deps = noLocalNetwork()
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { https: { connect: [`secure.example:${String(port)}`] } } }, [['https.connect', [`secure.example:${String(port)}`]]])

    const socket = await broker.net.connectSecure(APP, { host: 'secure.example', port, ca: caCert })

    expect(connects).toEqual([{ host: 'secure.example', port }])
    expect(socket.authorized).toBe(true)
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.dialSecure).not.toHaveBeenCalled()
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
    expect(socket.remoteAddress).toBe('secure.example')
    const chunks: Buffer[] = []
    const reader = socket.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello over the route')
    await socket.close()
  })

  it('refuses a certificate that does not name the host, as unreachable', async () => {
    const { route } = recordedRoute({ target: port })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { https: { connect: [`wrong.example:${String(port)}`] } } }, [['https.connect', [`wrong.example:${String(port)}`]]])

    const error = await rejection(broker.net.connectSecure(APP, { host: 'wrong.example', port, ca: caCert }))

    expect(error.code).toBe('unreachable')
  })

  it('reaches this machine as literals it checked, never through the route', async () => {
    const { route, connects } = recordedRoute({ target: 1 })
    const deps = { ...noLocalNetwork(), dialSecure: vi.fn(async () => okSecureSocket()) }
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { https: { connect: ['localhost:8443'] } } }, [['https.connect', ['localhost:8443']]])

    await broker.net.connectSecure(APP, { host: 'localhost', port: 8443 })

    expect(connects).toEqual([])
    expect(deps.dialSecure).toHaveBeenCalledWith({ host: 'localhost', port: 8443, addresses: ['127.0.0.1', '::1'] }, expect.anything(), expect.anything())
    expect(deps.resolve).not.toHaveBeenCalled()
  })

  it('keeps the grant and the address check: a private literal under a wildcard is denied before the route is asked', async () => {
    const { route, connects } = recordedRoute({ target: 1 })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { https: { connect: ['*:*'] } } }, [['https.connect', ['*:*']]])

    const error = await rejection(broker.net.connectSecure(APP, { host: '192.168.1.1', port: 443 }))

    expect(error.code).toBe('denied')
    expect(connects).toEqual([])
  })

  it('maps a route failure to unreachable', async () => {
    const { route } = recordedRoute({ connect: async () => { throw new Error('proxy down') } })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { https: { connect: ['api.example.com:443'] } } }, [['https.connect', ['api.example.com:443']]])

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('unreachable')
  })
})

describe('orivon.net.lookup for a routed app', () => {
  it('asks the route to resolve, and never the machine', async () => {
    const { route, resolves } = recordedRoute({ resolve: async () => [{ address: '93.184.216.34', family: 'IPv4' }] })
    const deps = noLocalNetwork()
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { connect: ['*:*'] } } }, [['tcp.connect', ['*:*']]])

    const answers = await broker.net.lookup(APP, { hostname: 'name.example' })

    expect(answers).toEqual([{ address: '93.184.216.34', family: 'IPv4' }])
    expect(resolves).toEqual(['name.example'])
    expect(deps.resolveLookup).not.toHaveBeenCalled()
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
  })

  it('is denied when the route has no resolve, and does not fall back to the machine', async () => {
    const { route } = recordedRoute({ resolve: null })
    const deps = noLocalNetwork()
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { connect: ['*:*'] } } }, [['tcp.connect', ['*:*']]])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'name.example' }))

    expect(error.code).toBe('denied')
    expect(deps.resolveLookup).not.toHaveBeenCalled()
  })

  it('still needs a network grant naming the host, before the route is asked', async () => {
    const { route, resolves } = recordedRoute({ resolve: async () => [{ address: '93.184.216.34', family: 'IPv4' }] })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['only.example:443'] } } }, [['tcp.connect', ['only.example:443']]])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'other.example' }))

    expect(error.code).toBe('denied')
    expect(resolves).toEqual([])
  })

  it('does not hand back a private answer the route returns', async () => {
    const { route } = recordedRoute({ resolve: async () => [{ address: '192.168.1.1', family: 'IPv4' }] })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['*:*'] } } }, [['tcp.connect', ['*:*']]])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'router.example' }))

    expect(error.code).toBe('unreachable')
  })

  it('maps a route failure to unreachable', async () => {
    const { route } = recordedRoute({ resolve: async () => { throw new Error('proxy down') } })
    const broker = routedBroker(route, noLocalNetwork())
    await registerAndGrant(broker, { net: { tcp: { connect: ['*:*'] } } }, [['tcp.connect', ['*:*']]])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'name.example' }))

    expect(error.code).toBe('unreachable')
  })
})
