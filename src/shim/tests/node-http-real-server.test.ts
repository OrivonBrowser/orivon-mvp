// Everything else in this directory fakes orivon.net.connect/connectSecure
// with an in-memory duplex. This file is the one exception, and it exists
// for a specific reason named in the queue item's own instructions: prove
// the wire framing (status line, headers, chunked decode, a real request
// body) against BYTES A REAL HTTP IMPLEMENTATION PRODUCED, not against this
// file's own idea of what HTTP looks like.
//
// It does not touch orivon.* or need a broker: `connectViaRealSocket` opens
// a real `node:net` socket to a real `node:http` server on loopback and
// bridges it through `Duplex.toWeb` into the exact TcpSocket shape
// (handles.ts) node-http-client.ts consumes -- the same bridge shape a real
// preload's socket-port.ts wraps a real OS socket in, just built directly
// against Node here instead of through the broker/IPC layers this lane does
// not own. This is the strongest verification available without the
// Electron launch this lane was not given.

import { createServer, type IncomingMessage as NodeServerRequest, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpModule, type ConnectFn } from '../node-http-client.js'
import type { IncomingMessage } from '../node-http-message.js'
import type { TcpSocket } from '../../contracts/handles.js'

async function withServer (handler: (req: NodeServerRequest, res: ServerResponse) => void): Promise<{ port: number, close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a real TCP address from listen(0)')
  return {
    port: address.port,
    close: async () => new Promise<void>((resolve, reject) => server.close((err) => (err !== undefined ? reject(err) : resolve())))
  }
}

/** Bridges a real node:net socket into the plaintext TcpSocket shape this shim consumes -- see this file's header. */
function connectViaRealSocket (): ConnectFn {
  return async ({ host, port }) => {
    const socket = netConnect({ host, port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const web = Duplex.toWeb(socket)
    const tcp: TcpSocket = {
      id: 'real-socket-bridge',
      closed: new Promise(() => {}),
      close: async () => { socket.destroy() },
      // Node's stream/web types are looser (ReadableStream<any>) than the
      // DOM lib type handles.ts uses -- the runtime shape is identical.
      readable: web.readable as ReadableStream<Uint8Array>,
      writable: web.writable as WritableStream<Uint8Array>,
      remoteAddress: host,
      remotePort: port,
      localAddress: '127.0.0.1',
      localPort: socket.localPort ?? 0,
      setNoDelay: async () => {},
      setKeepAlive: async () => {}
    }
    return tcp
  }
}

function collectBody (res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    res.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    res.on('end', () => {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) { out.set(c, offset); offset += c.length }
      resolve(new TextDecoder().decode(out))
    })
  })
}

let activeServer: { close: () => Promise<void> } | undefined

afterEach(async () => {
  await activeServer?.close()
  activeServer = undefined
})

describe('node-http-client.ts against a real node:http server', () => {
  it('completes a real GET request and parses a real Content-Length response', async () => {
    const server = await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello from a real server')
    })
    activeServer = server

    const http = createHttpModule({ connect: connectViaRealSocket(), defaultPort: server.port })
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/' })
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain')
    expect(await collectBody(res)).toBe('hello from a real server')
  })

  it('decodes a real chunked response identically to what a fixed-length one produces', async () => {
    const server = await withServer((_req, res) => {
      // No Content-Length given and more than one write(): Node's own http
      // server chooses Transfer-Encoding: chunked here, not this test.
      res.writeHead(200)
      res.write('chunk-one-')
      res.write('chunk-two')
      res.end()
    })
    activeServer = server

    const http = createHttpModule({ connect: connectViaRealSocket(), defaultPort: server.port })
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/' })
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))

    expect(res.headers['transfer-encoding']).toBe('chunked')
    expect(await collectBody(res)).toBe('chunk-one-chunk-two')
  })

  it('sends a real POST body the server receives byte-for-byte, with a correct Content-Length', async () => {
    const server = await withServer((req, res) => {
      const parts: Uint8Array[] = []
      req.on('data', (chunk: Uint8Array) => parts.push(chunk))
      req.on('end', () => {
        const received = Buffer.concat(parts).toString('utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received, contentLength: req.headers['content-length'] }))
      })
    })
    activeServer = server

    const http = createHttpModule({ connect: connectViaRealSocket(), defaultPort: server.port })
    const req = http.request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/echo' })
    req.write('hello ')
    req.end('world')
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))
    const parsed = JSON.parse(await collectBody(res)) as { received: string, contentLength: string }

    expect(parsed.received).toBe('hello world')
    expect(parsed.contentLength).toBe('11')
  })

  it('reaches a real 404 and reads its body like any other status', async () => {
    const server = await withServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found here')
    })
    activeServer = server

    const http = createHttpModule({ connect: connectViaRealSocket(), defaultPort: server.port })
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/missing' })
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))

    expect(res.statusCode).toBe(404)
    expect(await collectBody(res)).toBe('not found here')
  })
})
