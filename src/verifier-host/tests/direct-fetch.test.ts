import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCertificate } from '../serve/certificate.js'
import { createDirectFetch } from '../direct-fetch.js'

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

let fixture: Fixture | undefined
afterEach(async () => {
  if (fixture !== undefined) await new Promise<void>((resolve) => { fixture!.server.close(() => { resolve() }) })
  fixture = undefined
})

const fetch = createDirectFetch({ ca: cert.certPem })

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
