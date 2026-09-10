// A REAL node:tls server, a REAL certificate (generated fresh by
// ./tls-adapter.test-helpers.ts, never committed), and a REAL handshake --
// per this lane's own exit criterion, a mocked TLS layer proves nothing
// about certificate verification, which is the entire security property
// ADR-0017 rests on. Nothing in this file stubs tls, net, or the handshake
// itself.
//
// `createDialTls`'s optional `ca` is a TESTING SEAM ONLY: `DialSecure`
// (../../broker-contracts.ts) takes no such option, so nothing upstream of
// this file -- not net-capability.ts, not an app, not a grant -- can ever
// widen who the shipped adapter trusts. The production export, `dialTls`, is
// exactly `createDialTls()` with no argument, trusting only the runtime's
// own default certificate store.

import { createServer } from 'node:tls'
import type { Server } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDialTls, dialTls } from '../tls-adapter.js'
import { generateTlsFixture } from './tls-adapter.test-helpers.js'

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

async function readAll (readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('dialTls performs a real handshake with real certificate verification', () => {
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

  it('succeeds and carries real plaintext bytes when the requested host matches the certificate', async () => {
    const dial = createDialTls({ ca: fixtureCa })

    const socket = await dial('localhost', port, neverAborts())
    const text = await readAll(socket.readable)

    expect(text).toBe('hello from the real server')
  })

  it('REFUSES a wrong hostname against the identical live server -- the exit criterion\'s other half', async () => {
    const dial = createDialTls({ ca: fixtureCa })

    // Same TCP peer, same port, same certificate -- the ONLY thing that
    // changed is the hostname being verified. The certificate's SAN is
    // DNS:localhost only, so '127.0.0.1' -- naming the very same server by
    // its literal address instead of the name the certificate covers -- is
    // rejected by hostname verification, not by anything at the network
    // layer.
    await expect(dial('127.0.0.1', port, neverAborts())).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID'
    })
  })

  it('the production dialTls trusts no extra CA -- an untrusted self-signed certificate is rejected even for the right hostname', async () => {
    await expect(dialTls('localhost', port, neverAborts())).rejects.toMatchObject({
      // Node's own OpenSSL binding: an unknown issuer, not an altname problem --
      // proof this path is not silently trusting the fixture CA it never received.
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    })
  })
})
