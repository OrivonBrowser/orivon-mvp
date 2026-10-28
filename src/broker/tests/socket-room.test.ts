// A dial past the origin's socket allowance is refused BEFORE it reaches the
// network: without the look ahead, every such dial completed a TCP connect
// (and, for connectSecure, a TLS handshake) with the remote host, only to be
// torn down by acquire's own capacity check.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith, okSecureSocket, okSocket, resolvesPublic } from './index.test-helpers.js'

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
    const broker = createBroker(baseDeps({ resolve: resolvesPublic, dialSecure: async () => { handshakes++; return okSecureSocket() } }))
    await broker.registerApp(APP, manifestWith({ net: { https: { connect: ['api.example.com:443'] }, concurrentSockets: 1 } }))
    await broker.grant(APP, 'https.connect', ['api.example.com:443'])

    const first = await broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })
    await expect(broker.net.connectSecure(APP, { host: 'api.example.com', port: 443 })).rejects.toMatchObject({ code: 'limit' })
    expect(handshakes).toBe(1)
    await first.close()
  })
})

describe('the socket usage an origin reports', () => {
  it('counts the sockets it holds and the dial still running, against the allowance its manifest declares', async () => {
    let answer: (() => void) | undefined
    let dials = 0
    const broker = createBroker(baseDeps({
      dial: async () => {
        dials++
        if (dials === 1) return okSocket()
        return await new Promise((resolve) => { answer = () => { resolve(okSocket()) } })
      }
    }))
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] }, concurrentSockets: 4 } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
    expect(broker.app.socketUsageSync(APP)).toEqual({ open: 0, inFlight: 0, allowance: 4 })

    const held = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    const pending = broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    while (answer === undefined) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(broker.app.socketUsageSync(APP)).toEqual({ open: 1, inFlight: 1, allowance: 4 })

    answer()
    const second = await pending
    expect(broker.app.socketUsageSync(APP)).toEqual({ open: 2, inFlight: 0, allowance: 4 })
    await held.close()
    await second.close()
    expect(broker.app.socketUsageSync(APP)).toEqual({ open: 0, inFlight: 0, allowance: 4 })
  })

  it('answers zero for an origin it has never seen or cannot read, and keeps no table for it', async () => {
    const broker = createBroker(baseDeps({}))
    expect(broker.app.socketUsageSync('not an origin')).toMatchObject({ open: 0, inFlight: 0 })
    expect(broker.app.socketUsageSync('https://nobody.example')).toMatchObject({ open: 0, inFlight: 0 })
  })
})
