// The verifier host's routed fetch against the real chain it uses in the browser: the tunnel profile's front, which opens
// each stream through a SOCKS5 route, here the test fixture. A name only the fixture knows proves nothing is resolved here,
// and a stopped fixture proves nothing is dialled another way.

import { createServer as createPlainServer } from 'node:http'
import { createServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocks5Provider, isolationCredentials } from '../../../broker/route/socks5.js'
import { startSocks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import { createRunCertificate } from '../../../protocols/verifier-host/serve/certificate.js'
import { allowlisted } from '../../../protocols/verifier-host/egress.js'
import { createRoutedFetch, TunnelUnavailable } from '../../../protocols/verifier-host/routed-fetch.js'
import type { ProfileFront } from '../../../protocols/verifier-host/routed-fetch.js'
import { startRouteFront } from '../../route/front.js'
import type { RouteFront } from '../../route/front.js'

const HOST = 'gateway.routed.test'
const cert = createRunCertificate(new Date(), 30, HOST)
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

interface Target {
  readonly port: number
  readonly seen: Array<{ method: string, url: string, body: string }>
}

async function target (handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('from the far end') }): Promise<Target> {
  const seen: Target['seen'] = []
  const server: Server = createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString() })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) })
  return { port: (server.address() as AddressInfo).port, seen }
}

/** The fixture, a front whose route is the fixture, and the fetch that goes through the front. */
async function tunnel (far: Target): Promise<{ socks: Socks5Fixture, front: RouteFront, fetch: ReturnType<typeof createRoutedFetch>, profile: ProfileFront }> {
  const socks = await startSocks5Fixture({ preferAuth: true, names: { [`${HOST}:443`]: { host: '127.0.0.1', port: far.port } } })
  cleanups.push(async () => { await socks.close() })
  const credentials = isolationCredentials()('tunnel-profile')
  const provider = createSocks5Provider({ host: socks.host, port: socks.port, credentials })
  const front = await startRouteFront({ provider: () => provider })
  cleanups.push(async () => { await front.close() })
  const profile: ProfileFront = { port: front.port, username: front.username, password: front.secret }
  return { socks, front, profile, fetch: createRoutedFetch({ front: () => profile, ca: cert.certPem }) }
}

/** The port in the URL is what the fixture's name table maps: the name is dialled at 443 by the front, which the table sends to the target. */
const url = (path = '/'): string => `https://${HOST}${path}`

describe('the routed fetch', () => {
  it('reaches a name only the tunnel knows, sending it unresolved and signed in with the profile\'s credentials', async () => {
    const far = await target()
    const { socks, fetch } = await tunnel(far)
    const response = await fetch(url('/ipfs/bafy?format=raw'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('from the far end')
    expect(far.seen).toEqual([{ method: 'GET', url: '/ipfs/bafy?format=raw', body: '' }])
    expect(socks.requests).toHaveLength(1)
    expect(socks.requests[0]).toMatchObject({ command: 'connect', destination: HOST, addressType: 'domain', port: 443 })
    expect(socks.requests[0]?.userId).toBeDefined()
  })

  it('sends a POST body, a string or bytes, as it is', async () => {
    const far = await target((_req, res) => { res.writeHead(200).end('ok') })
    const { fetch } = await tunnel(far)
    await (await fetch(url('/rpc'), { method: 'POST', body: '{"id":1}', headers: { 'content-type': 'application/json' } })).text()
    await (await fetch(url('/rpc'), { method: 'POST', body: new TextEncoder().encode('{"id":2}').buffer })).text()
    expect(far.seen.map((request) => [request.method, request.body])).toEqual([['POST', '{"id":1}'], ['POST', '{"id":2}']])
  })

  it('hands a redirect back and follows nothing, so an allowlisted fetch refuses it', async () => {
    const far = await target((_req, res) => { res.writeHead(302, { location: 'https://elsewhere.test/' }).end() })
    const { fetch } = await tunnel(far)
    expect((await fetch(url())).status).toBe(302)
    await expect(allowlisted([`https://${HOST}`], fetch, 'a gateway')(url())).rejects.toThrow(/redirect/)
    expect(far.seen).toHaveLength(2)
  })

  it('fails when the tunnel is stopped, and the far end is never dialled another way', async () => {
    const far = await target()
    const { socks, fetch } = await tunnel(far)
    await socks.close()
    await expect(fetch(url())).rejects.toBeInstanceOf(TunnelUnavailable)
    expect(far.seen).toEqual([])
  })

  it('fails when the tunnel does not know the name', async () => {
    const far = await target()
    const { fetch } = await tunnel(far)
    await expect(fetch('https://unknown.routed.test/')).rejects.toBeInstanceOf(TunnelUnavailable)
    expect(far.seen).toEqual([])
  })

  it('fails when there is no tunnel profile front, and when the front does not accept the sign-in', async () => {
    const far = await target()
    const { profile } = await tunnel(far)
    await expect(createRoutedFetch({ front: () => undefined, ca: cert.certPem })(url())).rejects.toThrow(/no tunnel/)
    await expect(createRoutedFetch({ front: () => ({ ...profile, password: 'wrong' }), ca: cert.certPem })(url())).rejects.toThrow(/sign-in/)
    expect(far.seen).toEqual([])
  })

  it('reaches only https, unless a test build allows a plain-HTTP fixture', async () => {
    const { fetch } = await tunnel(await target())
    await expect(fetch('http://gateway.routed.test/')).rejects.toThrow(/only reaches https/)
    await expect(fetch(url(), { method: 'DELETE' })).rejects.toThrow(/GET, HEAD and POST/)
    await expect(fetch('https://user:pass@gateway.routed.test/')).rejects.toThrow(/credentials/)
  })

  it('refuses a certificate that is not for the name it asked for', async () => {
    const far = await target()
    const { profile } = await tunnel(far)
    await expect(createRoutedFetch({ front: () => profile })(url())).rejects.toThrow()
  })

  it('reaches a plain-HTTP fixture gateway the same way when a test build allows it, and keeps reusing its connection', async () => {
    const seen: string[] = []
    const plain = createPlainServer((req, res) => { seen.push(req.url ?? ''); res.writeHead(200).end('plain') })
    await new Promise<void>((resolve) => { plain.listen(0, '127.0.0.1', resolve) })
    cleanups.push(async () => { await new Promise<void>((resolve) => { plain.close(() => { resolve() }); plain.closeAllConnections() }) })
    const port = (plain.address() as AddressInfo).port
    const socks = await startSocks5Fixture({ preferAuth: true, names: { [`${HOST}:${String(port)}`]: { host: '127.0.0.1', port } } })
    cleanups.push(async () => { await socks.close() })
    const provider = createSocks5Provider({ host: socks.host, port: socks.port, credentials: isolationCredentials()('tunnel-profile') })
    const front = await startRouteFront({ provider: () => provider })
    cleanups.push(async () => { await front.close() })
    const fetch = createRoutedFetch({ front: () => ({ port: front.port, username: front.username, password: front.secret }), allowHttp: true })
    for (const path of ['/one', '/two']) expect(await (await fetch(`http://${HOST}:${String(port)}${path}`)).text()).toBe('plain')
    expect(seen).toEqual(['/one', '/two'])
    expect(socks.requests).toHaveLength(1)
  })
})
