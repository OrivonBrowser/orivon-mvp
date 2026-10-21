// The loopback front a routed app's Chromium sessions use as their proxy: it opens every tunnel and forwards every
// absolute-form request through the app's route and nowhere else, and answers nobody who lacks its secret.

import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteProvider } from '../../../broker/route/provider.js'
import { NOT_CARRIED_PAGE, startRouteFront } from '../front.js'
import type { RouteFront } from '../front.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function listening (server: Server): Promise<number> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const open = new Set<Socket>()
  server.on('connection', (socket) => { open.add(socket); socket.on('close', () => open.delete(socket)) })
  cleanups.push(async () => {
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

async function echoServer (): Promise<number> {
  const server = createTcpServer((socket) => { socket.on('error', () => {}); socket.on('data', (chunk) => socket.write(chunk)) })
  return await listening(server)
}

interface Seen { method?: string | undefined, url?: string | undefined, headers: Record<string, string | string[] | undefined>, body: string }

async function webServer (seen: Seen[]): Promise<number> {
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'target' })
      res.end('hello from the target')
    })
  })
  return await listening(server)
}

/** A route that knows two names, each pointing at a local server, and logs the names it was asked for. */
function providerFor (names: Record<string, number>, asked: string[] = []): RouteProvider {
  return {
    connect: async (host, port) => {
      asked.push(`${host}:${String(port)}`)
      const target = names[`${host}:${String(port)}`]
      if (target === undefined) throw new Error('the proxy does not know this name')
      return await new Promise((resolve, reject) => {
        const socket = netConnect({ host: '127.0.0.1', port: target })
        socket.once('connect', () => { socket.pause(); resolve(socket) })
        socket.once('error', reject)
      })
    }
  }
}

async function front (provider: RouteProvider | undefined, secret?: string): Promise<RouteFront> {
  const started = await startRouteFront({ provider: () => provider, ...(secret === undefined ? {} : { secret }) })
  cleanups.push(async () => { await started.close() })
  return started
}

const basic = (f: RouteFront): string => `Basic ${Buffer.from(`${f.username}:${f.secret}`).toString('base64')}`

/** Sends a CONNECT line and returns the status line and whatever came after it. */
async function connectThrough (f: RouteFront, target: string, authorization: string | undefined): Promise<{ status: string, socket: Socket }> {
  const socket = netConnect({ host: '127.0.0.1', port: f.port })
  cleanups.push(() => { socket.destroy() })
  await new Promise<void>((resolve) => { socket.once('connect', resolve) })
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization === undefined ? '' : `Proxy-Authorization: ${authorization}\r\n`}\r\n`)
  const head = await new Promise<string>((resolve) => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString()
      if (text.includes('\r\n\r\n')) { socket.off('data', onData); resolve(text) }
    }
    socket.on('data', onData)
    socket.on('close', () => { resolve(text) })
  })
  return { status: head.split('\r\n')[0] ?? '', socket }
}

async function getThrough (f: RouteFront, url: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: f.port, method, path: url, headers: { host: 'target.test', ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('the secret', () => {
  it('answers a CONNECT without it, or with a wrong one, with 407 and never asks the route', async () => {
    const asked: string[] = []
    const target = await echoServer()
    const f = await front(providerFor({ 'echo.test:443': target }, asked))

    expect((await connectThrough(f, 'echo.test:443', undefined)).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect((await connectThrough(f, 'echo.test:443', 'Basic ' + Buffer.from(`${f.username}:wrong`).toString('base64'))).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect((await connectThrough(f, 'echo.test:443', 'Bearer abc')).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect(asked).toEqual([])
  })

  it('answers a forwarded request without it with 407 and never asks the route', async () => {
    const asked: string[] = []
    const f = await front(providerFor({}, asked))

    const response = await getThrough(f, 'http://web.test/')

    expect(response.status).toBe(407)
    expect(response.headers['proxy-authenticate']).toMatch(/^Basic/)
    expect(asked).toEqual([])
  })

  it('is a different random value for each front', async () => {
    const one = await front(undefined)
    const two = await front(undefined)
    expect(one.secret).not.toBe(two.secret)
    expect(one.secret.length).toBeGreaterThanOrEqual(32)
  })
})

describe('CONNECT', () => {
  it('opens a tunnel through the route with the name as the app wrote it, and carries bytes both ways', async () => {
    const asked: string[] = []
    const target = await echoServer()
    const f = await front(providerFor({ 'echo.test:8443': target }, asked))

    const { status, socket } = await connectThrough(f, 'echo.test:8443', basic(f))
    expect(status).toBe('HTTP/1.1 200 Connection Established')
    const echoed = new Promise<string>((resolve) => { socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }) })
    socket.write('ping')

    expect(await echoed).toBe('ping')
    expect(asked).toEqual(['echo.test:8443'])
  })

  it('refuses a target that is not host:port without asking the route', async () => {
    const asked: string[] = []
    const f = await front(providerFor({}, asked))
    for (const bad of ['echo.test', 'echo.test:0', 'echo.test:70000', 'echo.test:abc', ':443', 'a b:443', '/x:443']) {
      expect((await connectThrough(f, bad, basic(f))).status, bad).toMatch(/^HTTP\/1\.1 400 /)
    }
    expect(asked).toEqual([])
  })

  it('answers 502 when the route cannot carry it, and does not connect anywhere else', async () => {
    const f = await front(providerFor({}))
    expect((await connectThrough(f, 'unknown.test:443', basic(f))).status).toBe('HTTP/1.1 502 Bad Gateway')
  })

  it('answers 503 when the app has no proxy to go through', async () => {
    const f = await front(undefined)
    expect((await connectThrough(f, 'echo.test:443', basic(f))).status).toBe('HTTP/1.1 503 Service Unavailable')
  })

  it('abandons the route attempt when the client gives up first', async () => {
    let aborted = false
    const slow: RouteProvider = { connect: async (_host, _port, signal) => await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('abandoned')) }) }) }
    const f = await front(slow)
    const socket = netConnect({ host: '127.0.0.1', port: f.port })
    cleanups.push(() => { socket.destroy() })
    await new Promise<void>((resolve) => { socket.once('connect', resolve) })
    socket.write(`CONNECT slow.test:443 HTTP/1.1\r\nHost: slow.test:443\r\nProxy-Authorization: ${basic(f)}\r\n\r\n`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    socket.destroy()

    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })
})

describe('absolute-form requests', () => {
  it('forwards the request through the route, without the secret, and returns the answer', async () => {
    const seen: Seen[] = []
    const asked: string[] = []
    const target = await webServer(seen)
    const f = await front(providerFor({ 'web.test:80': target }, asked))

    const response = await getThrough(f, 'http://web.test/path?q=1', { 'proxy-authorization': basic(f), 'x-keep': 'yes', 'proxy-connection': 'keep-alive' }, 'POST', 'payload')

    expect(response.status).toBe(200)
    expect(response.body).toBe('hello from the target')
    expect(response.headers['x-from']).toBe('target')
    expect(asked).toEqual(['web.test:80'])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/path?q=1', body: 'payload' })
    expect(seen[0]?.headers['x-keep']).toBe('yes')
    expect(seen[0]?.headers['proxy-authorization']).toBeUndefined()
    expect(seen[0]?.headers['proxy-connection']).toBeUndefined()
    expect(seen[0]?.headers.host).toBe('web.test')
  })

  it('does not pass on a header the client named in Connection, which describes its own hop', async () => {
    const seen: Seen[] = []
    const target = await webServer(seen)
    const f = await front(providerFor({ 'web.test:80': target }))

    await getThrough(f, 'http://web.test/', { 'proxy-authorization': basic(f), connection: 'x-hop, close', 'x-hop': 'only for the proxy', 'x-end-to-end': 'for the target' })

    expect(seen[0]?.headers['x-hop']).toBeUndefined()
    expect(seen[0]?.headers['x-end-to-end']).toBe('for the target')
  })

  it('closes the route\'s stream when the client gives up on a request mid-answer', async () => {
    let carrier: Socket | undefined
    const slowTarget = createTcpServer((socket) => { socket.on('error', () => {}); socket.once('data', () => { socket.write('HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\npartial') }) })
    const targetPort = await listening(slowTarget)
    const provider: RouteProvider = { connect: async (host, port, signal) => { carrier = await providerFor({ 'slow.test:80': targetPort }).connect(host, port, signal); return carrier } }
    const f = await front(provider)

    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: f.port, method: 'GET', path: 'http://slow.test/', headers: { host: 'slow.test', 'proxy-authorization': basic(f) } }, (res) => {
        res.once('data', () => { req.destroy(); resolve() })
      })
      req.on('error', () => {})
      req.end()
    })

    await vi.waitFor(() => { expect(carrier?.destroyed).toBe(true) })
  })

  it('refuses a request that is not for an http:// address, even with the secret', async () => {
    const asked: string[] = []
    const f = await front(providerFor({}, asked))
    for (const path of ['/', '/path', 'https://web.test/', 'ftp://web.test/', 'http://', '*']) {
      const response = await getThrough(f, path, { 'proxy-authorization': basic(f), host: 'web.test' })
      expect(response.status, path).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('answers 502 when the route cannot carry it, and 503 when there is no proxy', async () => {
    const down = await front(providerFor({}))
    expect((await getThrough(down, 'http://nowhere.test/', { 'proxy-authorization': basic(down) })).status).toBe(502)
    const none = await front(undefined)
    expect((await getThrough(none, 'http://nowhere.test/', { 'proxy-authorization': basic(none) })).status).toBe(503)
  })

  it('says in the answer that the tunnel did not carry the page, so a plain http page is not blank', async () => {
    const down = await front(providerFor({}))
    const answer = await getThrough(down, 'http://nowhere.test/', { 'proxy-authorization': basic(down) })
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(answer.body).toBe(NOT_CARRIED_PAGE)
    expect(answer.body).toContain('The tunnel did not carry this page')
    expect(Number(answer.headers['content-length'])).toBe(Buffer.byteLength(answer.body))
  })
})

describe('closing', () => {
  it('closeTunnels ends the tunnels that are open and keeps answering new ones', async () => {
    const target = await echoServer()
    const f = await front(providerFor({ 'echo.test:443': target }))
    const { socket } = await connectThrough(f, 'echo.test:443', basic(f))
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })

    f.closeTunnels()

    await closed
    expect((await connectThrough(f, 'echo.test:443', basic(f))).status).toBe('HTTP/1.1 200 Connection Established')
  })

  it('close ends the tunnels and stops listening', async () => {
    const target = await echoServer()
    const f = await front(providerFor({ 'echo.test:443': target }))
    const { socket } = await connectThrough(f, 'echo.test:443', basic(f))
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })

    await f.close()

    await closed
    await expect(new Promise<void>((resolve, reject) => {
      const probe = netConnect({ host: '127.0.0.1', port: f.port })
      probe.once('connect', () => { probe.destroy(); resolve() })
      probe.once('error', reject)
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
