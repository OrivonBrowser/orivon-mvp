// nodeReachDial for a routed origin: the TLS connection to the granted host is carried by the origin's route, the name
// is passed to the route unresolved, and a route that cannot carry it fails the request instead of letting it go direct.

import { connect as netConnect } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateTlsFixture } from '../../../broker/adapters/tests/tls-adapter.test-helpers.js'
import type { RouteProvider } from '../../../broker/route/provider.js'
import { nodeReachDial } from '../reach.js'

describe('nodeReachDial over a route', () => {
  let server: HttpsServer
  let port: number
  let ca: string
  let connections = 0

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    ca = fixture.caCert
    server = createHttpsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('through the route')
    })
    server.on('connection', () => { connections++ })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not report a port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  /** A route that knows the name `granted.test` only: it reaches the real server, whatever port the app wrote. */
  const routeToServer = (asked: string[]): RouteProvider => ({
    connect: async (host, requestedPort) => {
      asked.push(`${host}:${String(requestedPort)}`)
      return await new Promise((resolve, reject) => {
        const socket = netConnect({ host: '127.0.0.1', port })
        socket.once('connect', () => { socket.pause(); resolve(socket) })
        socket.once('error', reject)
      })
    }
  })

  it('opens the connection through the route with the name as the app wrote it, and verifies the certificate against that name', async () => {
    const asked: string[] = []
    const dial = nodeReachDial({ ca, routeProvider: () => routeToServer(asked) })
    // Nothing listens on port 9 here: a direct dial could not have answered.
    const request = new Request('https://localhost:9/x')

    const response = await dial(request, 'localhost', 9)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('through the route')
    expect(asked).toEqual(['localhost:9'])
  })

  it('still refuses a certificate that does not name the host', async () => {
    const asked: string[] = []
    const dial = nodeReachDial({ ca, routeProvider: () => routeToServer(asked) })

    await expect(dial(new Request('https://wrong-name.test/x'), 'wrong-name.test', 443)).rejects.toThrow()
    expect(asked).toEqual(['wrong-name.test:443'])
  })

  it('fails when the route cannot carry it, and goes nowhere else', async () => {
    const before = connections
    const dial = nodeReachDial({ ca, routeProvider: () => ({ connect: async () => { throw new Error('no proxy') } }) })

    await expect(dial(new Request(`https://localhost:${String(port)}/x`), 'localhost', port)).rejects.toThrow()
    expect(connections).toBe(before)
  })

  it('reads the route for every request, so an app switched off dials directly again', async () => {
    let provider: RouteProvider | undefined = routeToServer([])
    const dial = nodeReachDial({ ca, routeProvider: () => provider })
    expect((await dial(new Request('https://localhost:9/x'), 'localhost', 9)).status).toBe(200)

    provider = undefined
    expect((await dial(new Request(`https://localhost:${String(port)}/x`), 'localhost', port)).status).toBe(200)
  })
})
