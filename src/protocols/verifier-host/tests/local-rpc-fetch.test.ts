import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCertificate } from '../serve/certificate.js'
import { createLocalRpcFetch, localTargetOf } from '../local-rpc-fetch.js'

const SECRET = 'FAKE-KEY-0123456789'

interface Fixture {
  readonly server: Server
  readonly port: number
  readonly seen: Array<{ method: string, url: string, body: string, headers: IncomingMessage['headers'] }>
}

const servers: Array<{ close: (done: () => void) => void, closeAllConnections?: () => void }> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => { server.close(resolve) })
  }
})

async function listening (address: string, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fixture> {
  const seen: Fixture['seen'] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString(), headers: req.headers })
      handler(req, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve) })
  const bound = server.address()
  if (bound === null || typeof bound === 'string') throw new Error('no port')
  return { server, port: bound.port, seen }
}

const ok = (_req: IncomingMessage, res: ServerResponse): void => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":"0x1"}') }

const ipv6Loopback = await (async (): Promise<boolean> => {
  try {
    const probe = createServer()
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '::1', resolve) })
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
    return true
  } catch {
    return false
  }
})()

describe('the addresses the local fetch will reach', () => {
  it('takes localhost, loopback and private literals, and says which addresses to dial', () => {
    expect(localTargetOf('http://localhost:8545/')).toEqual({ hostname: 'localhost', addresses: ['127.0.0.1', '::1'] })
    expect(localTargetOf('http://127.0.0.1:8545/')).toEqual({ hostname: '127.0.0.1', addresses: ['127.0.0.1'] })
    expect(localTargetOf('http://10.1.2.3/')).toEqual({ hostname: '10.1.2.3', addresses: ['10.1.2.3'] })
    expect(localTargetOf('https://192.168.1.20:8545/x')).toEqual({ hostname: '192.168.1.20', addresses: ['192.168.1.20'] })
    expect(localTargetOf('http://172.20.0.9/')).toEqual({ hostname: '172.20.0.9', addresses: ['172.20.0.9'] })
    expect(localTargetOf('http://[::1]:8545/')).toEqual({ hostname: '::1', addresses: ['::1'] })
    expect(localTargetOf('http://[fd12:3456::7]/')).toEqual({ hostname: 'fd12:3456::7', addresses: ['fd12:3456::7'] })
  })

  it('refuses a public literal, a name, link-local, the unspecified address and every other class', () => {
    for (const url of ['http://8.8.8.8/', 'https://93.184.216.34/', 'http://[2606:4700::1111]/', 'https://rpc.example/', 'http://localhost.example/', 'http://sub.localhost/', 'http://169.254.169.254/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://100.64.0.1/', 'http://224.0.0.1/', 'http://eth.limo/']) {
      expect(() => localTargetOf(url), url).toThrow(/refuses to reach/)
    }
  })

  it('refuses other schemes, credentials in the address, and text that is no address', () => {
    expect(() => localTargetOf('ftp://127.0.0.1/')).toThrow(/only reaches http and https/)
    expect(() => localTargetOf('ws://127.0.0.1/')).toThrow(/only reaches http and https/)
    expect(() => localTargetOf('http://user:pw@127.0.0.1/')).toThrow(/credentials/)
    expect(() => localTargetOf('not an address')).toThrow()
  })

  it('names the refused host masked, never the path or the key in it', () => {
    for (const url of [`https://8.8.8.8/v3/${SECRET}`, `https://rpc.example/ogrpc?dkey=${SECRET}`, `http://user:${SECRET}@127.0.0.1/`.replace('127.0.0.1', 'rpc.example')]) {
      let message = ''
      try { localTargetOf(url) } catch (error) { message = (error as Error).message }
      expect(message, url).not.toContain(SECRET)
      expect(message, url).not.toBe('')
    }
  })
})

describe('createLocalRpcFetch', () => {
  it('sends a JSON-RPC POST given as bytes to a loopback server, path and query intact, and returns its answer', async () => {
    const fixture = await listening('127.0.0.1', ok)
    const fetch = createLocalRpcFetch()
    const body = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}')
    const response = await fetch(`http://127.0.0.1:${String(fixture.port)}/v3/${SECRET}?x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body.buffer as ArrayBuffer })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' })
    expect(fixture.seen).toHaveLength(1)
    expect(fixture.seen[0]).toMatchObject({ method: 'POST', url: `/v3/${SECRET}?x=1`, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })
    expect(fixture.seen[0]?.headers['content-type']).toBe('application/json')
    expect(fixture.seen[0]?.headers['content-length']).toBe(String(body.byteLength))
  })

  it('does a GET and a HEAD, and hands back a 4xx for the caller to read', async () => {
    const fixture = await listening('127.0.0.1', (_req, res) => { res.writeHead(401).end('no key') })
    const fetch = createLocalRpcFetch()
    const got = await fetch(`http://127.0.0.1:${String(fixture.port)}/`)
    expect(got.status).toBe(401)
    expect(await got.text()).toBe('no key')
    expect((await fetch(`http://127.0.0.1:${String(fixture.port)}/`, { method: 'HEAD' })).status).toBe(401)
  })

  it('refuses any other method', async () => {
    const fixture = await listening('127.0.0.1', ok)
    await expect(createLocalRpcFetch()(`http://127.0.0.1:${String(fixture.port)}/`, { method: 'DELETE' })).rejects.toThrow(/GET, HEAD and POST/)
    expect(fixture.seen).toHaveLength(0)
  })

  it('reaches a server by the name localhost, on the loopback addresses only', async () => {
    const fixture = await listening('127.0.0.1', ok)
    const response = await createLocalRpcFetch()(`http://localhost:${String(fixture.port)}/`)
    expect(response.status).toBe(200)
    expect(fixture.seen).toHaveLength(1)
  })

  it.skipIf(!ipv6Loopback)('reaches an IPv6 loopback literal', async () => {
    const fixture = await listening('::1', ok)
    const response = await createLocalRpcFetch()(`http://[::1]:${String(fixture.port)}/`)
    expect(response.status).toBe(200)
  })

  it('refuses a public address without opening a connection', async () => {
    const fixture = await listening('127.0.0.1', ok)
    const fetch = createLocalRpcFetch()
    await expect(fetch(`http://8.8.8.8:${String(fixture.port)}/v3/${SECRET}`)).rejects.toThrow(/refuses to reach 8\.8\.8\.8:\d+\/••••/)
    await expect(fetch(`http://169.254.169.254/latest/meta-data/`)).rejects.toThrow(/refuses to reach/)
    await expect(fetch('https://eth.drpc.org/')).rejects.toThrow(/refuses to reach/)
    expect(fixture.seen).toHaveLength(0)
  })

  it('follows no redirect: the 3xx comes back as it is and the other address is never asked', async () => {
    const elsewhere = await listening('127.0.0.1', ok)
    const fixture = await listening('127.0.0.1', (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${String(elsewhere.port)}/` }).end() })
    const response = await createLocalRpcFetch()(`http://127.0.0.1:${String(fixture.port)}/`, { redirect: 'follow' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain(String(elsewhere.port))
    expect(fixture.seen).toHaveLength(1)
    expect(elsewhere.seen).toHaveLength(0)
  })

  it('stops an answer that grows past the size limit, and one that declares it', async () => {
    const big = 'x'.repeat(500)
    const chunked = await listening('127.0.0.1', (_req, res) => { res.writeHead(200).write(big.slice(0, 250)); setTimeout(() => { res.end(big.slice(250)) }, 20) })
    const declared = await listening('127.0.0.1', (_req, res) => { res.writeHead(200, { 'content-length': String(big.length) }).end(big) })
    const small = await listening('127.0.0.1', (_req, res) => { res.writeHead(200).end('x'.repeat(80)) })
    const fetch = createLocalRpcFetch({ maxResponseBytes: 100 })
    await expect((await fetch(`http://127.0.0.1:${String(chunked.port)}/`)).text()).rejects.toThrow(/larger than 100 bytes/)
    await expect(fetch(`http://127.0.0.1:${String(declared.port)}/`)).rejects.toThrow(/larger than 100 bytes/)
    expect((await (await fetch(`http://127.0.0.1:${String(small.port)}/`)).text()).length).toBe(80)
  })

  it('does not hold a HEAD to the size limit, since it has no body to hold', async () => {
    const fixture = await listening('127.0.0.1', (_req, res) => { res.writeHead(200, { 'content-length': '99999' }).end() })
    const response = await createLocalRpcFetch({ maxResponseBytes: 100 })(`http://127.0.0.1:${String(fixture.port)}/`, { method: 'HEAD' })
    expect(response.status).toBe(200)
  })

  it('gives up on a server that carries no bytes, without naming its path', async () => {
    const fixture = await listening('127.0.0.1', () => {})
    const fetch = createLocalRpcFetch({ idleTimeoutMs: 150 })
    let message = ''
    try { await fetch(`http://127.0.0.1:${String(fixture.port)}/v3/${SECRET}`) } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/carried no bytes/)
    expect(message).not.toContain(SECRET)
  })

  it('names a refused connection without the path', async () => {
    const closed = await listening('127.0.0.1', ok)
    const port = closed.port
    await new Promise<void>((resolve) => { closed.server.close(() => { resolve() }) })
    let message = ''
    try { await createLocalRpcFetch()(`http://127.0.0.1:${String(port)}/v3/${SECRET}`) } catch (error) { message = (error as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain(SECRET)
  })

  it('checks a certificate as any client does: an untrusted one fails, one the person trusts passes', async () => {
    const cert = createRunCertificate(new Date(), 30, 'localhost')
    const server = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => { res.writeHead(200).end('secure') })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('no port')
    await expect(createLocalRpcFetch()(`https://localhost:${String(bound.port)}/`)).rejects.toThrow()
    await expect(createLocalRpcFetch()(`https://127.0.0.1:${String(bound.port)}/`)).rejects.toThrow()
    const trusting = createLocalRpcFetch({ ca: cert.certPem })
    expect(await (await trusting(`https://localhost:${String(bound.port)}/`)).text()).toBe('secure')
  })
})
