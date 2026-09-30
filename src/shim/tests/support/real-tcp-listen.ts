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
import { Duplex } from 'node:stream'
import type { TcpServer, TcpSocket } from '../../../contracts/handles.js'
import type { NetListenFn } from '../../net/server.js'

function wrap (raw: RealSocket): TcpSocket {
  const web = Duplex.toWeb(raw)
  return {
    id: 'real-accepted-socket',
    closed: new Promise<void>((resolve) => raw.once('close', () => resolve())),
    close: async () => { raw.destroy() },
    readable: web.readable as ReadableStream<Uint8Array>,
    writable: web.writable as WritableStream<Uint8Array>,
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
