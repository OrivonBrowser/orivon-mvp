// T20's fail-closed check (security-model.md, docs/open-questions.md A263)
// at the assembly layer: every native socket or resolve entry point in
// ../capabilities/net.ts and ../capabilities/net-connect-secure.ts refuses
// once `deps.proxyConfigured` answers true, and nothing about an ordinary
// grant changes when it answers false (`baseDeps`'s own default, so every
// OTHER test file in this suite already proves the false side for its own
// capability -- this file is the one place that proves the true side for
// every one of them, and that a real 'DIRECT' answer leaves connect working
// end to end).

import { describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import {
  APP, baseDeps, brokerWithConnectGrant, brokerWithConnectSecureGrant, manifestWith, okListenedServer, okUdpSocket
} from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Datagram } from '../../contracts/index.js'

const PROXIED = async (): Promise<boolean> => true

describe('T20: every net capability refuses when a proxy is configured', () => {
  it('tcp.connect', async () => {
    const broker = await brokerWithConnectGrant({ proxyConfigured: PROXIED })
    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))
    expect(error.code).toBe('denied')
  })

  it('connectSecure', async () => {
    const broker = await brokerWithConnectSecureGrant({ proxyConfigured: PROXIED })
    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))
    expect(error.code).toBe('denied')
  })

  it('tcp.listen', async () => {
    const broker = createBroker(baseDeps({ proxyConfigured: PROXIED, listen: async () => okListenedServer() }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { listen: { network: ['30000-30010'] } } } }))
    await broker.grant(APP, 'tcp.listen.network', ['30000-30010'])

    const error = await rejection(broker.net.listen(APP, { port: 30005 }))
    expect(error.code).toBe('denied')
  })

  it('udp.bind', async () => {
    const broker = createBroker(baseDeps({ proxyConfigured: PROXIED, bind: async () => okUdpSocket() }))
    broker.registerApp(APP, manifestWith({ net: { udp: { bind: { network: ['6881-6889'] } } } }))
    await broker.grant(APP, 'udp.bind.network', ['6881-6889'])

    const error = await rejection(broker.net.udpBind(APP, { port: 6885 }))
    expect(error.code).toBe('denied')
  })

  it('udp.send, read live per datagram exactly as a revoked grant is', async () => {
    // A closure flag, not two separate probes: `authorisedSend` reads
    // `deps.proxyConfigured` fresh per datagram (../capabilities/net.ts's own
    // "READ LIVE, NOT CAPTURED AT BIND" reasoning for the grant itself), so a
    // proxy that appears mid-session must stop the NEXT datagram, the same
    // property that reasoning already gives a revoke.
    let proxied = false
    const broker = createBroker(baseDeps({ proxyConfigured: async () => proxied, bind: async () => okUdpSocket() }))
    broker.registerApp(APP, manifestWith({ net: { udp: { bind: { network: ['6881-6889'] }, send: ['*:*'] } } }))
    await broker.grant(APP, 'udp.bind.network', ['6881-6889'])
    await broker.grant(APP, 'udp.send', ['*:*'])
    const socket = await broker.net.udpBind(APP, { port: 6885 })
    const datagram: Datagram = { data: new Uint8Array([1]), address: '93.184.216.34', port: 443, family: 'IPv4' }

    await expect(socket.send(datagram)).resolves.toEqual({ sent: true })
    proxied = true
    await expect(socket.send(datagram)).resolves.toEqual({ sent: false, code: 'denied' })
  })

  it('net.lookup', async () => {
    const broker = createBroker(baseDeps({ proxyConfigured: PROXIED }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])

    const error = await rejection(broker.net.lookup(APP, { hostname: 'api.example.com' }))
    expect(error.code).toBe('denied')
  })
})

describe('T20: a DIRECT answer changes nothing', () => {
  it('a real \'DIRECT\' resolveProxy answer still lets tcp.connect through, probed with the actual destination', async () => {
    const seen: string[] = []
    const broker = await brokerWithConnectGrant({
      proxyConfigured: async (url) => { seen.push(url); return false }
    })

    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })

    expect(socket.id).toEqual(expect.any(String))
    expect(seen).toEqual(['https://93.184.216.34:443/'])
  })
})
