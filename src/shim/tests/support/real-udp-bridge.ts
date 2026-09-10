// The dgram counterpart of node-http-real-server.test.ts's
// connectViaRealSocket: bridges a real `node:dgram` socket into the exact
// UdpSocket shape (handles.ts) node-dgram-socket.ts consumes, so a test can
// bind two independent shim sockets on real loopback UDP ports without a
// broker, a preload or an Electron launch. This is what makes it possible to
// drive a real vendored dependency (k-rpc-socket, bittorrent-dht) against
// this shim end to end, over an actual OS socket.

import { createSocket as createRealDgramSocket } from 'node:dgram'
import type { Datagram, SendRefusal, UdpSocket } from '../../../contracts/handles.js'
import type { UdpBindFn } from '../../node-dgram-socket.js'

export function bindViaRealUdp (): UdpBindFn {
  return async ({ port }) => {
    const raw = createRealDgramSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      raw.once('error', reject)
      raw.bind(port, '127.0.0.1', () => resolve())
    })
    const address = raw.address()

    let readableController!: ReadableStreamDefaultController<Datagram>
    const readable = new ReadableStream<Datagram>({
      start (controller) { readableController = controller }
    })
    raw.on('message', (data, rinfo) => {
      readableController.enqueue({
        data: new Uint8Array(data),
        address: rinfo.address,
        port: rinfo.port,
        family: rinfo.family === 'IPv6' ? 'IPv6' : 'IPv4'
      })
    })
    raw.on('error', (error) => readableController.error(error))

    const writable = new WritableStream<Datagram>({
      write (datagram) {
        return new Promise<void>((resolve, reject) => {
          raw.send(datagram.data, datagram.port, datagram.address, (error) => (error !== null ? reject(error) : resolve()))
        })
      }
    })

    const refusals = new ReadableStream<SendRefusal>({ start () {} })

    const handle: UdpSocket = {
      id: 'real-udp-bridge',
      closed: new Promise(() => {}),
      close: async () => { raw.close() },
      readable,
      writable,
      localAddress: address.address,
      localPort: address.port,
      droppedInbound: 0,
      droppedOutbound: 0,
      refusals
    }
    return handle
  }
}
