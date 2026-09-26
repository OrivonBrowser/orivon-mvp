// A REAL node:https server, a REAL certificate (generated fresh by
// ../../../broker/adapters/tests/tls-adapter.test-helpers.ts, never committed)
// and a REAL handshake -- same exit criterion as tls-adapter.test.ts and
// net-connect-secure-e2e.test.ts: a mocked TLS layer proves nothing about
// certificate verification, and that verification is nodeReachDial's own
// security property (its own file header explains why it is Node's `https`
// module doing it, not Electron's). Nothing here stubs `node:https`,
// `node:tls`, or the handshake itself.
//
// `ReachDialOptions.ca` mirrors `tls-adapter.ts`'s own `DialTlsOptions.ca`
// exactly, including the rule this suite exists to prove holds here too:
// production wiring (electron/serve.ts) never supplies one, trusting only
// the runtime's own root store -- this file is the only place a throwaway
// test CA is ever accepted.

import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateTlsFixture } from '../../../broker/adapters/tests/tls-adapter.test-helpers.js'
import { nodeReachDial, REACH_MAX_REQUEST_BODY_BYTES } from '../reach.js'

async function readAll (response: Response): Promise<string> {
  return await response.text()
}

describe('nodeReachDial -- A143\'s real, byte-moving half', () => {
  let server: HttpsServer
  let port: number
  let ca: string
  let received: { method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string } | undefined

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    ca = fixture.caCert
    server = createHttpsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://elsewhere.invalid/moved' })
          res.end()
          return
        }
        if (req.url === '/not-found') {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('nope')
          return
        }
        if (req.url === '/hop-by-hop') {
          // No content-length and two writes -> Node answers with a real
          // chunked transfer-encoding; Connection/Keep-Alive are set
          // explicitly to prove they get stripped too, not just the one
          // A174 was filed against.
          res.writeHead(200, { 'content-type': 'text/plain', connection: 'keep-alive', 'keep-alive': 'timeout=5' })
          res.write('first chunk, ')
          res.end('second chunk')
          return
        }
        res.writeHead(200, { 'content-type': 'font/woff2', 'x-custom': 'orivon-e2e' })
        res.end('real bytes from a real TLS server')
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not report a port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('THE BYTE-MOVING PROOF: a real GET over a real TLS handshake returns the server\'s own real bytes and headers', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://localhost:${String(port)}/font.woff2`)

    const response = await dial(request, 'localhost', port)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('font/woff2')
    expect(response.headers.get('x-custom')).toBe('orivon-e2e')
    expect(await readAll(response)).toBe('real bytes from a real TLS server')
    expect(received?.method).toBe('GET')
    expect(received?.url).toBe('/font.woff2')
  })

  it('forwards the request method, path+query and app-set headers verbatim -- no ambient cookie is ever attached, because nothing here has anywhere to store one', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://localhost:${String(port)}/x?y=1`, {
      method: 'POST', headers: { 'X-Marker': 'orivon' }, body: 'payload'
    })

    await dial(request, 'localhost', port)

    expect(received?.method).toBe('POST')
    expect(received?.url).toBe('/x?y=1')
    expect(received?.headers['x-marker']).toBe('orivon')
    expect(received?.headers.cookie).toBeUndefined()
    expect(received?.body).toBe('payload')
  })

  it('a wrong hostname against the identical real server and cert is refused by the real TLS handshake, not silently served', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://127.0.0.1:${String(port)}/font.woff2`)

    // The fixture certificate's SAN is DNS:localhost only (same fixture
    // net-connect-secure-e2e.test.ts uses) -- dialling "127.0.0.1" fails
    // hostname verification even though the TCP connection itself succeeds.
    await expect(dial(request, '127.0.0.1', port)).rejects.toThrow()
  })

  it('with no `ca` given (the production shape), a real self-signed server is refused by Node\'s own default trust store', async () => {
    const dial = nodeReachDial()
    const request = new Request(`https://localhost:${String(port)}/font.woff2`)

    await expect(dial(request, 'localhost', port)).rejects.toThrow()
  })

  it('a redirect from the granted host is handed back as an ordinary 3xx Response -- never followed to wherever Location points', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://localhost:${String(port)}/redirect`)

    const response = await dial(request, 'localhost', port)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://elsewhere.invalid/moved')
  })

  it('a real 404 from the granted host is returned as-is, not turned into a thrown error', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://localhost:${String(port)}/not-found`)

    const response = await dial(request, 'localhost', port)

    expect(response.status).toBe(404)
    expect(await readAll(response)).toBe('nope')
  })

  it('A174: strips hop-by-hop response headers -- transfer-encoding is false once Readable.toWeb has already de-chunked the body, and connection/keep-alive describe a hop that no longer applies', async () => {
    const dial = nodeReachDial({ ca })
    const request = new Request(`https://localhost:${String(port)}/hop-by-hop`)

    const response = await dial(request, 'localhost', port)

    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.get('keep-alive')).toBeNull()
    // Ordinary headers still pass through untouched.
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await readAll(response)).toBe('first chunk, second chunk')
  })
})

describe('nodeReachDial -- request body cap (A173)', () => {
  let server: HttpsServer
  let port: number
  let ca: string

  beforeAll(async () => {
    const fixture = generateTlsFixture()
    ca = fixture.caCert
    server = createHttpsServer({ key: fixture.leafKey, cert: fixture.leafCert }, (req, res) => {
      req.on('data', () => {}) // drain -- this suite never inspects the received body
      req.on('end', () => {
        if (req.url === '/echo-headers') {
          // A183: reports what the peer ACTUALLY received on the wire. The
          // only way to prove a smuggling pair was not forwarded -- asserting
          // on the Request handed in would re-read this test's own input,
          // never what Node put on the socket.
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(req.headers))
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not report a port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('refuses a request body over REACH_MAX_REQUEST_BODY_BYTES with a clear error, never buffering it whole in this (main) process', async () => {
    const dial = nodeReachDial({ ca })
    const oversized = new Uint8Array(REACH_MAX_REQUEST_BODY_BYTES + 1)
    const request = new Request(`https://localhost:${String(port)}/x`, { method: 'POST', body: oversized })

    await expect(dial(request, 'localhost', port)).rejects.toThrow(/REACH_MAX_REQUEST_BODY_BYTES/)
  })

  it('accepts a request body right at REACH_MAX_REQUEST_BODY_BYTES', async () => {
    const dial = nodeReachDial({ ca })
    const atCap = new Uint8Array(REACH_MAX_REQUEST_BODY_BYTES)
    const request = new Request(`https://localhost:${String(port)}/x`, { method: 'POST', body: atCap })

    const response = await dial(request, 'localhost', port)

    expect(response.status).toBe(200)
  })

  it('A183: refuses to smuggle -- an app-set transfer-encoding never reaches the peer alongside the content-length this file sets itself', async () => {
    const dial = nodeReachDial({ ca })
    // Exactly the pair that makes a front-end and a back-end disagree about
    // where this request ends. The app controls every header here and the
    // body bytes; nothing upstream of this file restricts either.
    const request = new Request(`https://localhost:${String(port)}/echo-headers`, {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked', te: 'trailers', upgrade: 'websocket', trailer: 'x-thing', 'x-keep': 'ordinary' },
      body: 'hello'
    })

    const response = await dial(request, 'localhost', port)
    const received = JSON.parse(await readAll(response)) as Record<string, string>

    // The smuggling pair: content-length is set by this file, so a forwarded
    // transfer-encoding is what turns one request into two.
    expect(received['transfer-encoding']).toBeUndefined()
    expect(received['content-length']).toBe('5')
    // The rest of RFC 7230 SS6.1, stripped for the same reason.
    expect(received['te']).toBeUndefined()
    expect(received['upgrade']).toBeUndefined()
    expect(received['trailer']).toBeUndefined()
    // An ordinary app header still passes through untouched.
    expect(received['x-keep']).toBe('ordinary')
  })
})
