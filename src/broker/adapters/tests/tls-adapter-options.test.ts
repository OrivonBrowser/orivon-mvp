// connectSecure's TLS options against REAL node:tls servers and REAL
// certificates (./tls-adapter.test-helpers.ts), through the production
// `dialTls` -- the adapter every app call reaches. Nothing here stubs the
// handshake: what these prove is what OpenSSL actually did with each option.

import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:tls'
import type { Server, TlsOptions, TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dialTls } from '../tls-adapter.js'
import type { DialedSecureSocket, SecureDialOptions } from '../../broker-contracts.js'
import { generateClientCertFixture, generateSelfSignedFixture, generateTlsFixture } from './tls-adapter.test-helpers.js'
import type { ClientCertFixture, SelfSignedFixture, TlsFixture } from './tls-adapter.test-helpers.js'

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

/** What a test server saw of each connection it completed. */
interface Seen { servername: string | false | null, peerCommonName: string | undefined, authorized: boolean }

interface TestServer { readonly server: Server, readonly port: number, readonly seen: Seen[] }

async function startServer (options: TlsOptions): Promise<TestServer> {
  const seen: Seen[] = []
  const server = createServer(options, (socket: TLSSocket) => {
    const peer = socket.getPeerCertificate()
    const cn = peer?.subject?.CN
    seen.push({ servername: socket.servername, peerCommonName: typeof cn === 'string' ? cn : undefined, authorized: socket.authorized })
    socket.end('hello from the real server')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not report a port')
  return { server, port: address.port, seen }
}

async function stopServer (server: TestServer | undefined): Promise<void> {
  if (server === undefined) return
  await new Promise<void>((resolve) => { server.server.close(() => resolve()) })
}

async function dial (port: number, options: SecureDialOptions, host = 'localhost', addresses?: readonly string[]): Promise<DialedSecureSocket> {
  return await dialTls(addresses === undefined ? { host, port } : { host, port, addresses }, options, neverAborts())
}

describe('a self-signed server: rejectUnauthorized and ca', () => {
  let fixture: SelfSignedFixture
  let server: TestServer

  beforeAll(async () => {
    fixture = generateSelfSignedFixture()
    server = await startServer({ key: fixture.key, cert: fixture.cert })
  })
  afterAll(async () => { await stopServer(server) })

  it('the default refuses it', async () => {
    await expect(dial(server.port, {})).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
  })

  it('rejectUnauthorized: false connects, carries bytes, and reports why verification failed', async () => {
    const socket = await dial(server.port, { rejectUnauthorized: false })

    expect(await readAll(socket.readable)).toBe('hello from the real server')
    expect(socket.authorized).toBe(false)
    expect(socket.authorizationError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })

  it('reports the peer certificate as plain data matching the one the server holds', async () => {
    const socket = await dial(server.port, { rejectUnauthorized: false })
    const expected = new X509Certificate(fixture.cert)

    const cert = socket.peerCertificate
    expect(cert).not.toBeNull()
    expect(cert?.subject).toEqual({ CN: 'localhost' })
    expect(cert?.subjectaltname).toBe('DNS:localhost')
    expect(cert?.fingerprint256).toBe(expected.fingerprint256)
    expect(cert?.fingerprint).toBe(expected.fingerprint)
    expect(cert?.serialNumber).toBe(expected.serialNumber)
    expect(cert?.valid_to).toBe(expected.validTo)
    expect(cert?.raw).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(cert?.raw ?? new Uint8Array()).equals(expected.raw)).toBe(true)
    expect(cert?.pubkey).toBeInstanceOf(Uint8Array)
    // Structured-cloneable: it crosses Electron IPC and contextBridge as data.
    expect(structuredClone(cert)).toEqual(cert)
    await socket.destroy('closed')
  })

  it('ca naming the self-signed certificate makes the default accept it', async () => {
    const socket = await dial(server.port, { ca: fixture.cert })

    expect(socket.authorized).toBe(true)
    expect(socket.authorizationError).toBeUndefined()
    expect(await readAll(socket.readable)).toBe('hello from the real server')
  })
})

describe('a CA-signed server: servername, addresses and ALPN', () => {
  let fixture: TlsFixture
  let server: TestServer
  let alpnServer: TestServer

  beforeAll(async () => {
    fixture = generateTlsFixture()
    server = await startServer({ key: fixture.leafKey, cert: fixture.leafCert })
    alpnServer = await startServer({ key: fixture.leafKey, cert: fixture.leafCert, ALPNProtocols: ['h2', 'http/1.1'] })
  })
  afterAll(async () => {
    await stopServer(server)
    await stopServer(alpnServer)
  })

  it('sends the granted host as SNI and verifies against it by default', async () => {
    const socket = await dial(server.port, { ca: fixture.caCert })

    expect(socket.authorized).toBe(true)
    await readAll(socket.readable)
    expect(server.seen.at(-1)?.servername).toBe('localhost')
  })

  it('a servername is sent as SNI and the certificate is verified against it, as Node does', async () => {
    await expect(dial(server.port, { ca: fixture.caCert, servername: 'other.example' }))
      .rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('with rejectUnauthorized: false a name mismatch is reported, not refused', async () => {
    const socket = await dial(server.port, { ca: fixture.caCert, servername: 'other.example', rejectUnauthorized: false })

    expect(socket.authorized).toBe(false)
    expect(socket.authorizationError).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    await readAll(socket.readable)
    expect(server.seen.at(-1)?.servername).toBe('other.example')
  })

  it('servername "" sends no SNI and still verifies against the host', async () => {
    const socket = await dial(server.port, { ca: fixture.caCert, servername: '' })

    expect(socket.authorized).toBe(true)
    await readAll(socket.readable)
    expect(server.seen.at(-1)?.servername).toBe(false)
  })

  it('dials the checked literal it is given, never the name, while SNI and verification still use the name', async () => {
    const socket = await dial(server.port, { ca: fixture.caCert }, 'localhost', ['127.0.0.1'])

    expect(socket.remoteAddress).toBe('127.0.0.1')
    expect(socket.authorized).toBe(true)
    await readAll(socket.readable)
    expect(server.seen.at(-1)?.servername).toBe('localhost')
  })

  it('tries the next checked literal when one refuses the connection', async () => {
    const socket = await dial(server.port, { ca: fixture.caCert }, 'localhost', ['::1', '127.0.0.1'])

    expect(socket.remoteAddress).toBe('127.0.0.1')
    await readAll(socket.readable)
  })

  it('negotiates ALPN from alpnProtocols, and reports false when none was offered', async () => {
    const negotiated = await dial(alpnServer.port, { ca: fixture.caCert, alpnProtocols: ['h2', 'http/1.1'] })
    const none = await dial(alpnServer.port, { ca: fixture.caCert })

    expect(negotiated.alpnProtocol).toBe('h2')
    expect(none.alpnProtocol).toBe(false)
    await negotiated.destroy('closed')
    await none.destroy('closed')
  })
})

describe('client certificates reach the server', () => {
  let server: TestServer
  let client: ClientCertFixture

  beforeAll(async () => {
    const serverFixture = generateSelfSignedFixture()
    client = generateClientCertFixture()
    server = await startServer({
      key: serverFixture.key,
      cert: serverFixture.cert,
      ca: client.caCert,
      requestCert: true,
      rejectUnauthorized: true
    })
  })
  afterAll(async () => { await stopServer(server) })

  it.each([
    ['cert and key', (c: ClientCertFixture): SecureDialOptions => ({ cert: c.cert, key: c.key })],
    ['cert and an encrypted key with its passphrase', (c: ClientCertFixture): SecureDialOptions => ({ cert: c.cert, key: c.encryptedKey, passphrase: c.passphrase })],
    ['a pfx with its passphrase', (c: ClientCertFixture): SecureDialOptions => ({ pfx: c.pfx, passphrase: c.passphrase })]
  ])('%s', async (_label, credentials) => {
    const socket = await dial(server.port, { rejectUnauthorized: false, ...credentials(client) })

    expect(await readAll(socket.readable)).toBe('hello from the real server')
    expect(server.seen.at(-1)).toMatchObject({ peerCommonName: client.commonName, authorized: true })
  })

  it('credentials the runtime cannot load reject as invalid, naming no key material', async () => {
    const garbage = 'orivon-test-not-a-private-key'

    const error = await dial(server.port, { rejectUnauthorized: false, cert: client.cert, key: garbage }).then(() => undefined, (e: unknown) => e)

    expect(error).toMatchObject({ name: 'OrivonError', code: 'invalid' })
    expect(String((error as Error).message)).not.toContain(garbage)
  })

  it('a wrong passphrase rejects as invalid', async () => {
    await expect(dial(server.port, { rejectUnauthorized: false, pfx: client.pfx, passphrase: 'wrong' }))
      .rejects.toMatchObject({ code: 'invalid' })
  })
})
