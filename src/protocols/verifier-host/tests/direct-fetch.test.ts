import { createServer } from 'node:https'
import type { Server } from 'node:https'
import { createServer as createTlsServer } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCertificate } from '../serve/certificate.js'
import { DirectAnswerRefused, createDirectFetch } from '../direct-fetch.js'

// An EXACT SAN, not the real run certificate's own `*.eth` wildcard: Node's
// default checkServerIdentity refuses that wildcard for any name at all
// (confirmed against a real .eth name too -- see createRunCertificate's own
// doc comment), which is fine for the real app (fingerprint-only, never
// hostname-checked) but exactly the check this fetch relies on, so the
// fixture needs a name a standard TLS client actually accepts.
const HOST = 'direct-fetch-test.example'
const cert = createRunCertificate(new Date(), 30, HOST)

interface Fixture {
  readonly server: Server
  readonly port: number
  readonly seenServername: string[]
  readonly seenPath: string[]
}

async function startFixture (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<Fixture> {
  const seenServername: string[] = []
  const seenPath: string[] = []
  const server = createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    const servername = (req.socket as TLSSocket).servername
    seenServername.push(typeof servername === 'string' ? servername : '')
    seenPath.push(req.url ?? '')
    handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port, seenServername, seenPath }
}

/** A TLS server that answers the first bytes of a request with `reply`
 * verbatim (or nothing at all), for answers no well-behaved HTTP server
 * would send. */
async function startRawFixture (reply: string | undefined): Promise<number> {
  const server = createTlsServer({ key: cert.keyPem, cert: cert.certPem }, (socket) => {
    rawSockets.add(socket)
    if (reply !== undefined) socket.once('data', () => { socket.write(reply) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  rawServer = server
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

let fixture: Fixture | undefined
let rawServer: import('node:tls').Server | undefined
const rawSockets = new Set<TLSSocket>()
afterEach(async () => {
  if (fixture !== undefined) await new Promise<void>((resolve) => { fixture!.server.close(() => { resolve() }) })
  fixture = undefined
  for (const socket of rawSockets) socket.destroy()
  rawSockets.clear()
  if (rawServer !== undefined) await new Promise<void>((resolve) => { rawServer!.close(() => { resolve() }) })
  rawServer = undefined
})

const fetch = createDirectFetch({ fixture: { ca: cert.certPem } })

describe('createDirectFetch', () => {
  it('connects to the pinned address although the hostname never resolves to it at all', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('hello') })
    const url = new URL(`https://${HOST}/path`)
    url.port = String(fixture.port)
    // HOST resolves nowhere real -- only the pinned 127.0.0.1 makes this
    // connect at all, proving the lookup override is what is actually used.
    const response = await fetch(url.toString(), undefined, ['127.0.0.1'])
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
  })

  it('sends SNI equal to the URL hostname, not the pinned address', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(200).end('ok') })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    const response = await fetch(url.toString(), undefined, ['127.0.0.1'])
    expect(response.status).toBe(200)
    expect(fixture.seenServername).toEqual([HOST])
  })

  it('reads the body and headers correctly on a plain 200', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw', 'x-extra': 'yes' }).end('the-bytes') })
    const url = new URL(`https://${HOST}/ipfs/bafy`)
    url.port = String(fixture.port)
    const response = await fetch(url.toString(), undefined, ['127.0.0.1'])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.ipld.raw')
    expect(response.headers.get('x-extra')).toBe('yes')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('the-bytes')
    expect(fixture.seenPath).toEqual(['/ipfs/bafy'])
  })

  it('refuses a certificate presented for a name it was not issued for', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(200).end('ok') })
    const url = new URL('https://not-the-certs-name.example/')
    url.port = String(fixture.port)
    await expect(fetch(url.toString(), undefined, ['127.0.0.1'])).rejects.toThrow()
  })

  it('never follows a redirect', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(302, { location: 'https://elsewhere.example/' }).end() })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    await expect(fetch(url.toString(), undefined, ['127.0.0.1'])).rejects.toThrow(/redirect/)
  })

  it('refuses a compressed body -- it only ever asks for identity', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.from('hi'))) })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    await expect(fetch(url.toString(), undefined, ['127.0.0.1'])).rejects.toThrow(/content-encoding/)
  })

  it('sends the identity accept-encoding on every request', async () => {
    let seenAcceptEncoding: string | undefined
    fixture = await startFixture((req, res) => { seenAcceptEncoding = req.headers['accept-encoding'] as string | undefined; res.writeHead(200).end('ok') })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    await fetch(url.toString(), undefined, ['127.0.0.1'])
    expect(seenAcceptEncoding).toBe('identity')
  })

  it('aborts mid-request when its own signal aborts', async () => {
    fixture = await startFixture((_req, res) => {
      res.writeHead(200)
      res.write('partial') // never end() -- the client aborts before completion
    })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    const controller = new AbortController()
    const promise = fetch(url.toString(), { signal: controller.signal }, ['127.0.0.1'])
    queueMicrotask(() => { controller.abort() })
    await expect(promise).rejects.toThrow()
  })

  it('sends its own Host, framing and accept-encoding, whatever the caller passes', async () => {
    let seen: import('node:http').IncomingHttpHeaders = {}
    fixture = await startFixture((req, res) => { seen = req.headers; res.writeHead(200).end('ok') })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    await fetch(url.toString(), { headers: { host: 'elsewhere.example', 'accept-encoding': 'gzip', accept: 'application/vnd.ipld.raw' } }, ['127.0.0.1'])
    expect(seen.host).toBe(`${HOST}:${String(fixture.port)}`)
    expect(seen['accept-encoding']).toBe('identity')
    expect(seen.accept).toBe('application/vnd.ipld.raw')
  })
})

describe('createDirectFetch -- a gateway answering what no honest one would', () => {
  function uncaughtDuring (): { readonly errors: unknown[], readonly stop: () => void } {
    const errors: unknown[] = []
    const listener = (error: unknown): void => { errors.push(error) }
    process.on('uncaughtException', listener)
    return { errors, stop: () => { process.off('uncaughtException', listener) } }
  }

  it('rejects a status outside 200-599 instead of throwing uncaught', async () => {
    const port = await startRawFixture('HTTP/1.1 999 Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    const uncaught = uncaughtDuring()
    try {
      await expect(fetch(`https://${HOST}:${String(port)}/ipfs/x`, undefined, ['127.0.0.1'])).rejects.toBeInstanceOf(DirectAnswerRefused)
    } finally {
      uncaught.stop()
    }
    expect(uncaught.errors).toEqual([])
  })

  it('rejects 101 Switching Protocols rather than never settling', async () => {
    const port = await startRawFixture('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    await expect(fetch(`https://${HOST}:${String(port)}/ipfs/x`, undefined, ['127.0.0.1'])).rejects.toBeInstanceOf(DirectAnswerRefused)
  })

  it('gives up on a connection that carries nothing, even with no signal', async () => {
    const port = await startRawFixture(undefined)
    const quick = createDirectFetch({ fixture: { ca: cert.certPem }, idleTimeoutMs: 200 })
    await expect(quick(`https://${HOST}:${String(port)}/ipfs/x`, undefined, ['127.0.0.1'])).rejects.toThrow(/carried no bytes/)
  })

  it('gives up after an informational answer followed by silence', async () => {
    const port = await startRawFixture('HTTP/1.1 103 Early Hints\r\nLink: </x>; rel=preload\r\n\r\n')
    const quick = createDirectFetch({ fixture: { ca: cert.certPem }, idleTimeoutMs: 200 })
    await expect(quick(`https://${HOST}:${String(port)}/ipfs/x`, undefined, ['127.0.0.1'])).rejects.toThrow(/carried no bytes/)
  })
})

describe('createDirectFetch -- what it will dial', () => {
  const real = createDirectFetch()

  it('refuses a loopback, private or zone-scoped address', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '::ffff:127.0.0.1', '2606:4700::1%eth0', '169.254.169.254']) {
      await expect(real(`https://${HOST}/`, undefined, [address])).rejects.toThrow(/refuses to dial/)
    }
  })

  it('refuses a public address not written in its canonical form', async () => {
    await expect(real(`https://${HOST}/`, undefined, ['2606:4700:0:0:0:0:0:1'])).rejects.toThrow(/refuses to dial/)
  })

  it('refuses any port but 443', async () => {
    await expect(real(`https://${HOST}:8443/`, undefined, ['93.184.216.34'])).rejects.toThrow(/port 443/)
  })

  it('refuses anything but https', async () => {
    await expect(createDirectFetch()('http://example.com/', undefined, ['93.184.216.34'])).rejects.toThrow(/https/)
  })

  it('refuses a method other than GET or HEAD', async () => {
    await expect(createDirectFetch()(`https://${HOST}/`, { method: 'POST' }, ['127.0.0.1'])).rejects.toThrow(/GET.HEAD/)
  })

  it('refuses an empty address list', async () => {
    await expect(createDirectFetch()(`https://${HOST}/`, undefined, [])).rejects.toThrow(/pinned address/)
  })
})

describe('createDirectFetch -- allowPost and allowRedirect, opted into for CCIP-Read', () => {
  it('still refuses POST when allowPost is not set', async () => {
    await expect(createDirectFetch()(`https://${HOST}/`, { method: 'POST', body: 'x' }, ['127.0.0.1'])).rejects.toThrow(/GET.HEAD/)
  })

  it('sends a POST body to the pinned address, still with the real hostname for TLS and Host', async () => {
    let seenBody = ''
    let seenHost: string | undefined
    fixture = await startFixture((req, res) => {
      seenHost = req.headers.host
      req.on('data', (chunk: Buffer) => { seenBody += chunk.toString() })
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":"0xfeed"}') })
    })
    const post = createDirectFetch({ fixture: { ca: cert.certPem }, allowPost: true })
    const url = new URL(`https://${HOST}/lookup`)
    url.port = String(fixture.port)
    const response = await post(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"data":"0x1234"}' }, ['127.0.0.1'])
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"data":"0xfeed"}')
    expect(seenBody).toBe('{"data":"0x1234"}')
    expect(seenHost).toBe(`${HOST}:${String(fixture.port)}`)
  })

  it('refuses a POST whose body is not a string', async () => {
    const post = createDirectFetch({ fixture: { ca: cert.certPem }, allowPost: true })
    await expect(post(`https://${HOST}/`, { method: 'POST', body: new Blob(['x']) }, ['127.0.0.1'])).rejects.toThrow(/string/)
  })

  it('still refuses a redirect when allowRedirect is not set', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(302, { location: 'https://elsewhere.example/' }).end() })
    const url = new URL(`https://${HOST}/`)
    url.port = String(fixture.port)
    await expect(fetch(url.toString(), undefined, ['127.0.0.1'])).rejects.toThrow(/redirect/)
  })

  it('hands back a redirect response, location header included, when allowRedirect is set', async () => {
    fixture = await startFixture((_req, res) => { res.writeHead(302, { location: '/b' }).end() })
    const redirecting = createDirectFetch({ fixture: { ca: cert.certPem }, allowRedirect: true })
    const url = new URL(`https://${HOST}/a`)
    url.port = String(fixture.port)
    const response = await redirecting(url.toString(), undefined, ['127.0.0.1'])
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/b')
  })
})
