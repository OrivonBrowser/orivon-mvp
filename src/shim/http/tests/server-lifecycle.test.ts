import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { Server as NetServer } from '../../net/server.js'
import { IncomingMessage } from '../message.js'
import { ServerResponse } from '../server-response.js'
import { Server, createServer, kListen } from '../server.js'
import { listenViaRealSocket } from '../../tests/support/real-tcp-listen.js'
import { fetchFrom, rawExchange, startServer, stopServers, waitFor } from '../../tests/support/http-server-harness.js'

afterEach(stopServers)

describe('createServer and listen', () => {
  it('builds a Server that is a net.Server and an EventEmitter, from either argument order Node accepts', () => {
    const listener = (): void => {}
    const first = createServer(listener)
    const second = createServer({ keepAliveTimeout: 10 }, listener)
    const third = new Server()
    for (const server of [first, second, third]) {
      expect(server).toBeInstanceOf(Server)
      expect(server).toBeInstanceOf(NetServer)
    }
    expect(first.listeners('request')).toEqual([listener])
    expect(second.keepAliveTimeout).toBe(10)
    expect(third.listenerCount('request')).toBe(0)
  })

  it('listen(port, callback), listen({ port }) and listen(0) all bind, emit listening and answer address()', async () => {
    for (const listen of [
      (server: Server, done: () => void) => server.listen(0, done),
      (server: Server, done: () => void) => server.listen({ port: 0 }, done),
      (server: Server, done: () => void) => { server.once('listening', done); server.listen(0) }
    ]) {
      const server = createServer({ [kListen]: listenViaRealSocket() }, (_req, res) => { res.end('ok') })
      expect(server.listening).toBe(false)
      expect(server.address()).toBeNull()
      await new Promise<void>((resolve) => listen(server, resolve))
      expect(server.listening).toBe(true)
      const address = server.address() as { port: number, family: string }
      expect(address.port).toBeGreaterThan(0)
      expect(address.family).toBe('IPv4')
      expect((await fetchFrom(address.port, '/')).text).toBe('ok')
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('refuses a loopback-only host by name, as net.Server does: orivon.net.listen binds every interface', () => {
    const server = createServer({ [kListen]: listenViaRealSocket() })
    expect(() => server.listen(0, '127.0.0.1')).toThrow(/every interface/)
    expect(() => server.listen(0, '0.0.0.0')).not.toThrow()
    server.close()
  })

  it('reports a listen the broker refuses as an error event with the broker\'s code', async () => {
    const denied = Object.assign(new Error('tcp.listen is not granted'), { code: 'denied' })
    const server = createServer({ [kListen]: async () => { throw denied } })
    const error = new Promise<Error & { code?: string }>((resolve) => server.once('error', resolve))
    server.listen(0)
    expect((await error).code).toBe('denied')
  })

  it('takes custom IncomingMessage and ServerResponse classes, as Node\'s options do', async () => {
    class MyRequest extends IncomingMessage { marker = 'req' }
    class MyResponse extends ServerResponse { marker = 'res' }
    const seen: string[] = []
    const { port } = await startServer((req, res) => { seen.push((req as MyRequest).marker, (res as MyResponse).marker); res.end() }, { IncomingMessage: MyRequest, ServerResponse: MyResponse })
    await fetchFrom(port, '/')
    expect(seen).toEqual(['req', 'res'])
  })

  it('reports a request listener that throws as an uncaught error and keeps serving', async () => {
    const uncaught: unknown[] = []
    const capture = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', capture)
    try {
      const { port } = await startServer((req, res) => {
        if (req.url === '/boom') throw new Error('handler failed')
        res.end('fine')
      })
      await rawExchange(port, 'GET /boom HTTP/1.1\r\nHost: x\r\n\r\n', { timeoutMs: 150 })
      await waitFor(() => uncaught.length === 1)
      expect((uncaught[0] as Error).message).toBe('handler failed')
      expect((await fetchFrom(port, '/ok')).text).toBe('fine')
    } finally {
      process.off('uncaughtException', capture)
    }
  })
})

function acceptKey (key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

describe('upgrade and CONNECT', () => {
  it('hands an upgrade request to the upgrade listener with the socket and the bytes behind the head, and a WebSocket-style exchange runs on it', async () => {
    const seen: Record<string, unknown> = {}
    const { server, port } = await startServer((_req, res) => { res.end('ordinary') })
    server.on('upgrade', (req, socket, head) => {
      seen.method = req.method
      seen.url = req.url
      seen.upgrade = req.upgrade
      seen.head = head.toString()
      seen.isBytes = head instanceof Uint8Array
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`)
      socket.on('data', (data: Buffer) => { socket.write(Buffer.concat([Buffer.from('echo:'), data])) })
    })
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    const client = await new Promise<{ headers: Record<string, unknown>, echoed: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/socket', agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key } })
      req.on('upgrade', (res, socket) => {
        socket.once('data', (data: Buffer) => resolve({ headers: res.headers, echoed: data.toString() }))
        socket.write('frame-1')
      })
      req.on('response', () => reject(new Error('answered as an ordinary request')))
      req.on('error', reject)
      req.end()
    })
    expect(client.headers['sec-websocket-accept']).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    expect(client.echoed).toBe('echo:frame-1')
    expect(seen).toMatchObject({ method: 'GET', url: '/socket', upgrade: true, isBytes: true })
  })

  it('passes bytes sent right behind the upgrade head, and delivers nothing until the app listens', async () => {
    const chunks: string[] = []
    const { server, port } = await startServer()
    server.on('upgrade', (_req, socket, head) => {
      chunks.push(`head ${head.toString()}`)
      setTimeout(() => { socket.on('data', (d: Buffer) => chunks.push(`data ${d.toString()}`)) }, 80)
    })
    await rawExchange(port, ['GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nHEAD', 'LATER'], { gapMs: 20, timeoutMs: 300 })
    expect(chunks).toEqual(['head HEAD', 'data LATER'])
  })

  it('treats an upgrade request as an ordinary one when nobody listens for upgrade', async () => {
    const seen: unknown[] = []
    const { port } = await startServer((req, res) => { seen.push(req.upgrade, req.headers.upgrade); res.end('ordinary') })
    const { data } = await rawExchange(port, 'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', { until: 'ordinary' })
    expect(data).toContain('ordinary')
    expect(seen).toEqual([false, 'websocket'])
  })

  it('emits connect for CONNECT with its own head bytes, and closes a CONNECT nobody listens for', async () => {
    const { server, port } = await startServer((_req, res) => { res.end() })
    const closedWithoutListener = await rawExchange(port, 'CONNECT a:80 HTTP/1.1\r\nHost: a:80\r\n\r\n', { timeoutMs: 500 })
    expect(closedWithoutListener).toEqual({ data: '', closed: true })
    const seen: string[] = []
    server.on('connect', (req, socket, head) => { seen.push(`${String(req.method)} ${String(req.url)} ${head.toString()}`); socket.end('HTTP/1.1 200 Connection Established\r\n\r\n') })
    const { data } = await rawExchange(port, 'CONNECT a:80 HTTP/1.1\r\nHost: a:80\r\n\r\nTUNNEL', { timeoutMs: 500 })
    expect(data).toBe('HTTP/1.1 200 Connection Established\r\n\r\n')
    expect(seen).toEqual(['CONNECT a:80 TUNNEL'])
  })

  it('does not count an upgraded socket as idle, and close() waits for it as Node\'s does', async () => {
    const { server, port } = await startServer()
    let upgraded: import('../../net/socket.js').Socket | undefined
    server.on('upgrade', (_req, socket) => { upgraded = socket; socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n') })
    const client = await new Promise<import('node:net').Socket>((resolve) => {
      const req = request({ host: '127.0.0.1', port, agent: false, headers: { Connection: 'Upgrade', Upgrade: 'x' } })
      req.on('upgrade', (_res, socket) => resolve(socket))
      req.end()
    })
    let closed = false
    server.close(() => { closed = true })
    await new Promise((r) => setTimeout(r, 150))
    expect(closed).toBe(false)
    upgraded?.destroy()
    client.destroy()
    await waitFor(() => closed)
  })
})
