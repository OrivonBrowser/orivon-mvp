import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { ResolutionError } from '../../../resolution/records.js'
import type { NameRecord } from '../../../resolution/records.js'
import type { DataGatherer, GatheredFile, MountedSite, NameResolver } from '../../../resolution/providers.js'
import { ProtocolRegistry } from '../../../registry.js'
import { defineProtocol } from '../../../protocol.js'
import { ENS } from '../../../ens/descriptor.js'
import { OWN_READ_HEADER, PARTITION_HEADER, ROUTE_HEADER } from '../../../../loader/fetch/content-root.js'
import type { FromHost, RelayRequest } from '../../protocol.js'
import { createRunCertificate } from '../certificate.js'
import { createVerifierServer } from '../server.js'
import { RoutedSites, Sites } from '../sites.js'
import { ShellRelay } from '../shell-relay.js'

// The verifier's own server with a shell behind it: a host the shell serves is handed to it before anything of the
// server's own is looked at, and a read the shell itself made is answered by the server alone.

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const TOKEN = 'a-secret-chosen-at-random'

const verifierBytes = Buffer.from('from the verifier')
const site: MountedSite = {
  gatherer: 'stub',
  root: { kind: 'ipfs', cid: ROOT },
  pointers: [],
  open: async (path): Promise<GatheredFile> => ({ servedPath: path, size: verifierBytes.length, body: (async function * () { yield verifierBytes })() }),
  ddoc: () => ({ status: 'met', refusals: [] })
}
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: ROOT }, provenance: { via: 'fixture' } }
const resolver: NameResolver = {
  id: 'stub',
  namespaces: ['.eth'],
  resolve: async (name) => {
    if (name === 'kept.eth' || name === 'plain.eth') return [record]
    throw new ResolutionError('not-found', 'no such name')
  }
}
const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }
const registry = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })])

const posted: FromHost[] = []
const relay = new ShellRelay({ post: (message) => posted.push(message), ownReadToken: TOKEN })
relay.setServed(['https://kept.eth'])

let server: Server
let port: number
beforeAll(async () => {
  server = createVerifierServer(registry, new RoutedSites(new Sites(registry), () => new Sites(registry)), createRunCertificate(), undefined, undefined, undefined, relay)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  relay.dispose()
  server.closeAllConnections()
  server.close()
})

interface Reply { status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }

async function get (path: string, options: { host?: string, method?: string, headers?: Record<string, string> } = {}): Promise<Reply> {
  const host = options.host ?? 'kept.eth'
  return await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', servername: host, rejectUnauthorized: false, headers: { host, [PARTITION_HEADER]: `https://${host}`, 'sec-fetch-site': 'same-origin', ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
      res.on('error', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
      res.on('aborted', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
    })
    req.on('error', () => { resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }) })
    req.end()
  })
}

const relayed = (): RelayRequest[] => posted.filter((message): message is RelayRequest => message.type === 'relay-request')

async function until (check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 2000; tries += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never: ${what}`)
}

describe('the loopback server with a shell behind it', () => {
  it('hands a request for a host the shell serves to the shell, and writes the shell\'s answer as it was given', async () => {
    const before = relayed().length
    const reply = get('/app.js', { headers: { range: 'bytes=0-2' } })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    expect(sent.url).toBe('https://kept.eth/app.js')
    expect(sent.headers).toEqual(expect.arrayContaining([['range', 'bytes=0-2']]))
    relay.receive({ type: 'relay-head', id: sent.id, status: 206, headers: [['content-type', 'text/javascript'], ['content-range', 'bytes 0-2/9'], ['content-security-policy', "default-src 'self'"]] })
    relay.receive({ type: 'relay-body', id: sent.id, chunk: new TextEncoder().encode('run') })
    relay.receive({ type: 'relay-end', id: sent.id })
    const done = await reply
    expect(done.status).toBe(206)
    expect(done.body.toString()).toBe('run')
    expect(done.headers['content-range']).toBe('bytes 0-2/9')
    expect(done.headers['content-security-policy']).toBe("default-src 'self', treat-as-public-address; frame-ancestors 'self'")
  })

  it('hands over a request no page started, which the browser marks as its own', async () => {
    const before = relayed().length
    const reply = get('/app.js', { headers: { [PARTITION_HEADER]: '', 'sec-fetch-site': 'none' } })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    relay.receive({ type: 'relay-head', id: sent.id, status: 204, headers: [] })
    relay.receive({ type: 'relay-end', id: sent.id })
    expect((await reply).status).toBe(204)
  })

  it('answers another site\'s subresource and frame as it always did, so that page cannot tell the app is kept', async () => {
    const before = relayed().length
    const image = await get('/app.js', { headers: { [PARTITION_HEADER]: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } })
    expect(image.status).toBe(200)
    expect(image.body.toString()).toBe('from the verifier')
    const frame = await get('/', { headers: { [PARTITION_HEADER]: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })
    expect(frame.body.toString()).toBe('from the verifier')
    expect(relayed()).toHaveLength(before)
  })

  it('hands over the top-level navigation another site\'s link makes, so the link opens the kept copy', async () => {
    const before = relayed().length
    const reply = get('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    relay.receive({ type: 'relay-head', id: sent.id, status: 204, headers: [] })
    relay.receive({ type: 'relay-end', id: sent.id })
    expect((await reply).status).toBe(204)
  })

  it('hands over what the site\'s own frame asks for under another site\'s page, which the browser marks same-origin', async () => {
    const before = relayed().length
    const reply = get('/app.js', { headers: { [PARTITION_HEADER]: 'https://evil.example', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    relay.receive({ type: 'relay-head', id: sent.id, status: 204, headers: [] })
    relay.receive({ type: 'relay-end', id: sent.id })
    expect((await reply).status).toBe(204)
  })

  it('answers a request of a tunnel profile\'s page itself while the app is only served live, so its reads still leave through the tunnel', async () => {
    const before = relayed().length
    const reply = await get('/app.js', { headers: { [ROUTE_HEADER]: 'nym' } })
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('from the verifier')
    expect(relayed()).toHaveLength(before)
  })

  it('hands over a request of a tunnel profile\'s page once the app is served from its pin, which reads nothing from the network', async () => {
    relay.setServed(['https://kept.eth'], ['https://kept.eth'])
    const before = relayed().length
    const reply = get('/app.js', { headers: { [ROUTE_HEADER]: 'nym' } })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    relay.receive({ type: 'relay-head', id: sent.id, status: 204, headers: [] })
    relay.receive({ type: 'relay-end', id: sent.id })
    expect((await reply).status).toBe(204)
    relay.setServed(['https://kept.eth'])
  })

  it('refuses a target that reads as another host before it hands anything over', async () => {
    const before = relayed().length
    expect((await get('/\\plain.eth/x')).status).toBe(400)
    expect(relayed()).toHaveLength(before)
  })

  it('hands over a method other than GET and HEAD as well, and lets the shell answer it', async () => {
    const before = relayed().length
    const reply = get('/app.js', { method: 'POST' })
    await until(() => relayed().length === before + 1, 'the request was relayed')
    const sent = relayed().at(-1)!
    expect(sent.method).toBe('POST')
    relay.receive({ type: 'relay-head', id: sent.id, status: 404, headers: [] })
    relay.receive({ type: 'relay-end', id: sent.id })
    expect((await reply).status).toBe(404)
  })

  it('answers a read the shell itself made from the verifier, without handing it back', async () => {
    const before = relayed().length
    const reply = await get('/app.js', { headers: { [OWN_READ_HEADER]: TOKEN } })
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('from the verifier')
    expect(relayed()).toHaveLength(before)
  })

  it('answers a host the shell does not serve as it always did', async () => {
    const before = relayed().length
    const reply = await get('/app.js', { host: 'plain.eth' })
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('from the verifier')
    expect(relayed()).toHaveLength(before)
  })

  it('refuses a host no protocol serves before it hands anything over', async () => {
    relay.setServed(['https://kept.eth', 'https://example.com'])
    const before = relayed().length
    expect((await get('/app.js', { host: 'example.com' })).status).toBe(421)
    expect(relayed()).toHaveLength(before)
    relay.setServed(['https://kept.eth'])
  })

  it('refuses a path that is not one before it hands anything over', async () => {
    const before = relayed().length
    expect((await get('//evil.example/x')).status).toBe(400)
    expect(relayed()).toHaveLength(before)
  })

  it('hands the request to the verifier again once the shell stops serving the host', async () => {
    relay.setServed([])
    const reply = await get('/app.js')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('from the verifier')
    relay.setServed(['https://kept.eth'])
  })
})
