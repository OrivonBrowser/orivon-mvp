// The listening counterpart of http/tests/real-server.test.ts's
// connectViaRealSocket: bridges a real `node:net` server into the TcpServer
// shape (handles.ts) net/server.ts consumes, so a test can run the shim's
// net.Server and http.Server on a real loopback port, without a broker, a
// preload or an Electron launch, and drive them with real Node clients.
//
// `connections` is a highWaterMark: 0 stream like the broker's: a connection
// is delivered only when the consumer has asked for one. Closing the server
// closes every accepted socket, as the broker does with its derived handles.

import { createServer as createRealServer, type Socket as RealSocket } from 'node:net'
import type { TcpServer, TcpSocket } from '../../../contracts/handles.js'
import type { NetListenFn } from '../../net/server.js'

/**
 * The byte streams of one accepted socket. Built by hand: Duplex.toWeb waits for
 * 'close' before it ends the readable side, and a half-open socket (the peer sent
 * its FIN, this side has not) never closes, so the broker's "readable ended on FIN"
 * would go unseen.
 */
function streamsOf (raw: RealSocket): { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> } {
  let ended = false
  const readable = new ReadableStream<Uint8Array>({
    start (controller) {
      raw.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) raw.pause()
      })
      raw.on('end', () => { ended = true; controller.close() })
      raw.on('close', () => { if (!ended) { ended = true; controller.error(new Error('connection reset')) } })
    },
    pull () { raw.resume() },
    cancel () { raw.destroy() }
  }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength })
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => await new Promise<void>((resolve, reject) => { raw.write(chunk, (error) => (error == null ? resolve() : reject(error))) }),
    close: async () => await new Promise<void>((resolve) => { raw.end(() => resolve()) }),
    abort: () => { raw.destroy() }
  })
  return { readable, writable }
}

function wrap (raw: RealSocket): TcpSocket {
  const { readable, writable } = streamsOf(raw)
  return {
    id: 'real-accepted-socket',
    closed: new Promise<void>((resolve) => raw.once('close', () => resolve())),
    close: async () => { raw.destroy() },
    readable,
    writable,
    remoteAddress: raw.remoteAddress ?? '127.0.0.1',
    remotePort: raw.remotePort ?? 0,
    localAddress: raw.localAddress ?? '127.0.0.1',
    localPort: raw.localPort ?? 0,
    setNoDelay: async (noDelay) => { raw.setNoDelay(noDelay) },
    setKeepAlive: async (enable, delay) => { raw.setKeepAlive(enable, delay) }
  }
}

export function listenViaRealSocket (): NetListenFn {
  return async ({ port }) => {
    const real = createRealServer({ allowHalfOpen: true })
    const accepted = new Set<RealSocket>()
    const queue: TcpSocket[] = []
    let controller!: ReadableStreamDefaultController<TcpSocket>
    let asked = false
    const deliver = (): void => {
      if (!asked || queue.length === 0) return
      asked = false
      controller.enqueue(queue.shift() as TcpSocket)
    }
    const connections = new ReadableStream<TcpSocket>({
      start (c) { controller = c },
      pull () { asked = true; deliver() }
    }, new CountQueuingStrategy({ highWaterMark: 0 }))
    real.on('connection', (raw) => {
      accepted.add(raw)
      raw.on('error', () => {})
      raw.once('close', () => accepted.delete(raw))
      queue.push(wrap(raw))
      deliver()
    })
    await new Promise<void>((resolve, reject) => {
      real.once('error', reject)
      real.listen(port, '127.0.0.1', resolve)
    })
    const address = real.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address from listen')
    const server: TcpServer = {
      id: 'real-tcp-server',
      closed: new Promise<void>((resolve) => real.once('close', () => resolve())),
      close: async () => {
        for (const raw of accepted) raw.destroy()
        await new Promise<void>((resolve) => real.close(() => resolve()))
      },
      connections,
      localAddress: '127.0.0.1',
      localPort: address.port
    }
    return server
  }
}
