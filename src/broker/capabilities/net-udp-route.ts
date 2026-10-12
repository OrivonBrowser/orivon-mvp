// What a routed app's UDP socket adds to a bound one (./net-udp.ts): datagrams
// to anything but this machine leave through the route's own channel, opened
// when the first one is sent, and what comes back is read from that channel.
// The bound socket stays on loopback and carries loopback traffic only.

import { isIP } from 'node:net'
import type { Datagram } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'
import type { BoundUdpSocket, SendOutcome } from '../broker-contracts.js'
import { isLoopbackTarget } from '../policy/connect-routed.js'
import { mapRouteError } from '../route/provider.js'
import type { Route, RoutedDatagram, RoutedUdp } from '../route/provider.js'

export interface RoutedUdpBinding {
  /** The bound socket as the handle should see it: inbound merged with the route's, closing the route's channel with it. */
  readonly socket: BoundUdpSocket
  /** Sends one already-authorised datagram through `route`. Never rejects. */
  readonly sendThrough: (route: Route, host: string, port: number, data: Uint8Array) => Promise<SendOutcome>
}

function refused (error: unknown): SendOutcome {
  const mapped = mapRouteError(error)
  return mapped.platformCode === undefined ? { sent: false, code: mapped.code } : { sent: false, code: mapped.code, platformCode: mapped.platformCode }
}

export function routeBoundUdp (bound: BoundUdpSocket): RoutedUdpBinding {
  const lifetime = new AbortController()
  let open: { readonly route: Route, readonly channel: Promise<RoutedUdp> } | undefined
  let controller: ReadableStreamDefaultController<Datagram> | undefined
  let refusedInbound = 0
  const reader = bound.readable.getReader()
  const windowBytes = LIMITS.inboundDatagramWindowBytes

  const readable = new ReadableStream<Datagram>({
    start (c) { controller = c },
    // One datagram from the bound socket per pull, so its own window still
    // applies. Only this machine can write to a loopback socket; a source
    // that is not loopback is not accepted.
    async pull (c) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) { c.close(); return }
          if (isLoopbackTarget(value.address)) { c.enqueue(value); return }
          refusedInbound += 1
        }
      } catch (error) {
        c.error(error)
      }
    },
    cancel: async (reason) => { await reader.cancel(reason) }
  }, {
    highWaterMark: windowBytes,
    size: (datagram) => Math.max(datagram.data.byteLength, windowBytes / LIMITS.inboundDatagramWindow)
  })

  function fromRoute (datagram: RoutedDatagram): void {
    if (controller === undefined || controller.desiredSize === null || controller.desiredSize <= 0) {
      refusedInbound += 1
      return
    }
    try {
      controller.enqueue({ data: datagram.data, address: datagram.host, port: datagram.port, family: isIP(datagram.host) === 6 ? 'IPv6' : 'IPv4' })
    } catch {
      refusedInbound += 1
    }
  }

  async function channelFor (route: Route): Promise<RoutedUdp> {
    if (open !== undefined && open.route === route) return await open.channel
    const previous = open
    if (previous !== undefined) void previous.channel.then(async (channel) => { await channel.close() }, () => {})
    const opener = route.provider.udp
    if (opener === undefined) throw Object.assign(new Error('the route cannot carry datagrams'), { code: 'EOPNOTSUPP' })
    const channel = opener.call(route.provider, lifetime.signal).then((made) => {
      made.onDatagram(fromRoute)
      made.onClose(() => { if (open?.channel === channel) open = undefined })
      return made
    })
    open = { route, channel }
    channel.catch(() => { if (open?.channel === channel) open = undefined })
    return await channel
  }

  async function sendThrough (route: Route, host: string, port: number, data: Uint8Array): Promise<SendOutcome> {
    if (data.byteLength > LIMITS.maxDatagramBytes) return { sent: false, code: 'invalid' }
    if (route.provider.udp === undefined) return { sent: false, code: 'denied' }
    try {
      const channel = await channelFor(route)
      if (lifetime.signal.aborted) {
        await channel.close()
        return { sent: false, code: 'closed' }
      }
      await channel.send({ host, port, data })
      return { sent: true }
    } catch (error) {
      return refused(error)
    }
  }

  const socket: BoundUdpSocket = {
    readable,
    send: bound.send,
    localAddress: bound.localAddress,
    localPort: bound.localPort,
    get droppedInbound () { return bound.droppedInbound + refusedInbound },
    destroy: async (reason) => {
      lifetime.abort()
      const current = open
      open = undefined
      try {
        await (await current?.channel)?.close()
      } catch {
        // A channel that never opened has nothing to close.
      }
      await bound.destroy(reason)
    }
  }
  return { socket, sendThrough }
}
