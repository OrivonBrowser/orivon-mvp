// The lane's own exit criterion, proven at the FULL broker level: a real
// handshake against a real local server with a real certificate, granted
// through an ordinary https.connect grant and dialled through the real
// `createDialTls` adapter -- not a stub anywhere in this file. A wrong
// hostname is refused by the SAME real certificate check, reached through
// the SAME broker call.
//
// `createDialTls({ ca })`'s `ca` is a testing-only seam (../adapters/
// tls-adapter.ts's own doc) -- there is no other way to hand a local test
// server a certificate a real trusted root actually signed. The production
// wiring (../transport/ipc.ts's brokerIpcSubsystem) uses `dialTls` with no
// argument, trusting only the runtime's own default store.

import { createServer } from 'node:tls'
import type { Server } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import { createDialTls } from '../adapters/tls-adapter.js'
import { generateTlsFixture } from '../adapters/tests/tls-adapter.test-helpers.js'

describe('net.connectSecure end to end: a real handshake, and a real refusal', () => {
  let server: Server
  let port: number
  let fixtureCa: string

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    fixtureCa = fixture.caCert
    server = createServer({ key: fixture.leafKey, cert: fixture.leafCert }, (socket) => {
      socket.end('hello from the real server')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not report a port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('grants https.connect for "localhost", dials the real server, and reads real plaintext bytes back', async () => {
    const broker = createBroker(baseDeps({ dialSecure: createDialTls({ ca: fixtureCa }) }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: [`localhost:${String(port)}`] } } }))
    await broker.grant(APP, 'https.connect', [`localhost:${String(port)}`])

    const socket = await broker.net.connectSecure(APP, { host: 'localhost', port })

    const reader = socket.readable.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello from the real server')
    await socket.close()
  })

  it('THE EXIT CRITERION: a wrong hostname against the identical real server and grant is refused, as \'unreachable\' with a real platformCode', async () => {
    // Granting '127.0.0.1' -- not 'localhost' -- for the SAME port, so the
    // request clears the POLICY check (checkConnectSecure) and reaches the
    // real handshake. The certificate's SAN is DNS:localhost only, so
    // hostname verification is the thing that refuses this, not the grant.
    const broker = createBroker(baseDeps({ dialSecure: createDialTls({ ca: fixtureCa }) }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: [`127.0.0.1:${String(port)}`] } } }))
    await broker.grant(APP, 'https.connect', [`127.0.0.1:${String(port)}`])

    const error = await rejection(broker.net.connectSecure(APP, { host: '127.0.0.1', port }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
  })

  it('a hostname the grant never named is refused by POLICY, before any handshake is attempted', async () => {
    const broker = createBroker(baseDeps({ dialSecure: createDialTls({ ca: fixtureCa }) }))
    broker.registerApp(APP, manifestWith({ net: { https: { connect: [`localhost:${String(port)}`] } } }))
    await broker.grant(APP, 'https.connect', [`localhost:${String(port)}`])

    const error = await rejection(broker.net.connectSecure(APP, { host: '127.0.0.1', port }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })
})
