// orivon.net.connectSecure -- the https.connect sibling of ./index.test.ts's
// tcp.connect suite. Everything already proven generically for `connect`
// (denial shape, revocation cascade, the abort/reset close table) is NOT
// re-proven here wholesale -- `toFailableSocket` in ../net-capability.ts is
// the same wrapper for both, so duplicating that coverage would test the
// shared code twice and the NEW code (the https.connect grant lookup, the
// hostname-based policy check, dialSecure, mapTlsError) not at all. What
// follows is scoped to what is actually different.
//
// Real certificate verification is NOT exercised with a stub here -- that
// is ./net-connect-secure-e2e.test.ts's job, against a real node:tls server
// and a real certificate. This file uses a stub `dialSecure` so the policy
// and wiring can be tested in isolation from the handshake itself.

import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, brokerWithConnectSecureGrant, manifestWith, okSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { DialSecure } from '../broker-contracts.js'

/** One real event-loop tick -- enough for connectSecure's synchronous policy check to reach dialSecure. */
function nextTick (): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('https.connect is a grant separate from tcp.connect', () => {
  it('denies connectSecure when only tcp.connect was granted for the same host', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('denies every call when https.connect was never granted at all', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['*:*'] } } }))

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('denied')
  })

  it('granting tcp.connect does not also authorise connect() -- the raw path is unaffected by connectSecure existing', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'https.connect', ['93.184.216.34:443'])

    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))

    expect(error.code).toBe('denied')
  })
})

describe('the hostname the app asked for authorises the call, never a resolved address', () => {
  it('denies a host the granted https.connect pattern does not name, without ever calling dialSecure', async () => {
    const dialSecure = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ dialSecure }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.connectSecure(APP, { host: 'evil.example.com', port: 443 }))

    expect(error.code).toBe('denied')
    expect(dialSecure).not.toHaveBeenCalled()
  })

  it('passes dialSecure the checked, normalised host -- never the raw string the app supplied', async () => {
    const calls: Array<{ host: string, port: number }> = []
    const dialSecure: DialSecure = async (host, port) => {
      calls.push({ host, port })
      return okSocket()
    }
    const broker = createBroker(baseDeps({ dialSecure }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['API.example.com:443'] } } }))
    await broker.grant(APP, 'https.connect', ['API.example.com:443'])

    await broker.net.connectSecure(APP, { host: 'api.EXAMPLE.com.', port: 443 })

    expect(calls).toEqual([{ host: 'api.example.com', port: 443 }])
  })
})

describe('a failed handshake is \'unreachable\' with a real platformCode, never a generic denial', () => {
  it('maps a certificate/hostname mismatch thrown by dialSecure through mapTlsError', async () => {
    const dialSecure: DialSecure = async () => {
      throw Object.assign(new Error('Hostname/IP does not match certificate\'s altnames'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID'
      })
    }
    const broker = await brokerWithConnectSecureGrant({ dialSecure })

    const error = await rejection(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
  })
})

describe('revocation tears down a secure socket exactly as it does a plain one', () => {
  it('closes an open secure socket the moment its grant is revoked', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] } } }))
    const g = await broker.grant(APP, 'https.connect', ['api.example.com:443'])
    const socket = await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })

    await broker.revoke(APP, g.id)

    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('destroys a socket whose handshake finishes after its grant was revoked mid-flight, and never registers it', async () => {
    let resolveDial!: (socket: Awaited<ReturnType<DialSecure>>) => void
    const dialed = new Promise<Awaited<ReturnType<DialSecure>>>((resolve) => { resolveDial = resolve })
    const destroySpy = vi.fn()
    const dialSecure: DialSecure = async () => await dialed
    const broker = createBroker(baseDeps({ dialSecure }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] } } }))
    const g = await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    const pending = broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })
    await nextTick()

    await broker.revoke(APP, g.id)
    const error = await rejection(pending)
    expect(error.code).toBe('revoked')

    // The handshake "completes" only now -- late, after the grant is gone.
    resolveDial(okSocket({ destroy: destroySpy }))
    await nextTick()

    expect(destroySpy).toHaveBeenCalledWith('revoked')
    expect(destroySpy).not.toHaveBeenCalledWith('failed')
  })
})
