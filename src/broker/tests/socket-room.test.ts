// A dial past the origin's socket allowance is refused BEFORE it reaches the
// network: without the look ahead, every such dial completed a TCP connect
// (and, for connectSecure, a TLS handshake) with the remote host, only to be
// torn down by acquire's own capacity check.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith, okSecureSocket, okSocket } from './index.test-helpers.js'

describe('an outbound dial past the socket allowance never reaches the remote host', () => {
  it('net.connect refuses the second socket with limit, and dials only once', async () => {
    let dials = 0
    const broker = createBroker(baseDeps({ dial: async () => { dials++; return okSocket() } }))
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] }, concurrentSockets: 1 } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const first = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    await expect(broker.net.connect(APP, { host: '93.184.216.34', port: 443 })).rejects.toMatchObject({ code: 'limit' })
    expect(dials).toBe(1)

    await first.close()
    const again = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    expect(dials).toBe(2)
    await again.close()
  })

  it('net.connectSecure refuses the second socket with limit, and never starts a second handshake', async () => {
    let handshakes = 0
    const broker = createBroker(baseDeps({ dialSecure: async () => { handshakes++; return okSecureSocket() } }))
    await broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] }, concurrentSockets: 1 } }))
    await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    const first = await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })
    await expect(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })).rejects.toMatchObject({ code: 'limit' })
    expect(handshakes).toBe(1)
    await first.close()
  })
})
