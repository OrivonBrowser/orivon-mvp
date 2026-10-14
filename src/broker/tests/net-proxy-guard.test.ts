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
import { GENERIC_PROXY_PROBE_URL } from '../policy/proxy-guard.js'
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

  it('an over-long host is refused before the probe runs, for every outbound entry point', async () => {
    const asked: string[] = []
    const probe = async (url: string): Promise<boolean> => { asked.push(url); return false }
    const huge = 'a'.repeat(128 * 1024)

    const plain = await brokerWithConnectGrant({ proxyConfigured: probe })
    expect((await rejection(plain.net.connect(APP, { host: huge, port: 443 }))).code).toBe('denied')

    const secure = await brokerWithConnectSecureGrant({ proxyConfigured: probe })
    expect((await rejection(secure.net.connectSecure(APP, { host: huge, port: 443 }))).code).toBe('denied')

    const udp = createBroker(baseDeps({ proxyConfigured: probe, bind: async () => okUdpSocket() }))
    udp.registerApp(APP, manifestWith({ net: { udp: { bind: { network: ['6881-6889'] }, send: ['*:*'] } } }))
    await udp.grant(APP, 'udp.bind.network', ['6881-6889'])
    await udp.grant(APP, 'udp.send', ['*:*'])
    const socket = await udp.net.udpBind(APP, { port: 6885 })
    const sent = await socket.send({ data: new Uint8Array([1]), address: huge, port: 443, family: 'IPv4' })
    expect(sent).toEqual({ sent: false, code: 'denied' })

    expect(await udp.app.reachBypassesProxy(APP, huge, 443)).toBe(true)
    // Binding probes the generic URL; nothing derived from the app's host is ever asked.
    expect(asked.filter((url) => url !== GENERIC_PROXY_PROBE_URL)).toEqual([])
  })
})
