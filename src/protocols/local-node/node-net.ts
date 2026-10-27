// A local node's network, as the WASI host's SocketNet: the broker's Node
// adapters behind the policy below. The node holds no grant, so this seam is
// the whole defence against a hostile peer or a hostile DNS answer; the rules
// and the reasons are in README.md.

import { randomUUID } from 'node:crypto'
import type { SocketNet } from '../../shim/wasi-p2/addresses.js'
import type { BindScope, Datagram, LookupAddress, SendRefusal, TcpServer, TcpSocket, UdpSocket } from '../../contracts/index.js'
import type { Bind, Dial, DialedSocket, Listen } from '../../broker/broker-contracts.js'
import { dialTcp, listenTcp, resolveLookup } from '../../broker/adapters/node-adapters.js'
import { bindUdp } from '../../broker/adapters/udp-adapter.js'
import { fail } from '../../broker/errors.js'
import { canonicalAddress, isPublicUnicast } from '../../broker/policy/address.js'

export const MAX_SOCKETS = 300
export const MAX_LISTENERS = 4
export const MAX_ANSWERS = 64
/** The one port a datagram may be sent to: the Swarm node asks a public resolver for its bootnodes' records. */
export const DNS_PORT = 53
const REFUSAL_QUEUE = 16

export interface NodeNetDeps {
  readonly dial: Dial
  readonly listen: Listen
  readonly bind: Bind
  readonly lookup: (hostname: string) => Promise<readonly LookupAddress[]>
}

/** The adapters a node runs on, with the system resolver for names. */
export const REAL: NodeNetDeps = { dial: dialTcp, listen: listenTcp, bind: bindUdp, lookup: resolveLookup }

class Budget {
  #open = 0
  constructor (private readonly limit: number, private readonly what: string) {}

  /** Counts one more; the function it returns gives it back, once. */
  take (): () => void {
    if (this.#open >= this.limit) throw fail('limit', `the node already holds ${String(this.limit)} ${this.what}`)
    this.#open += 1
    let given = false
    return () => {
      if (given) return
      given = true
      this.#open -= 1
    }
  }
}

/** A socket's handle, which frees its place once both directions have ended or `close()` is called. */
function socketHandle (dialed: DialedSocket, release: () => void): TcpSocket {
  const reader = dialed.readable.getReader()
  const writer = dialed.writable.getWriter()
  let readEnded = false
  let writeEnded = false
  let settle: () => void = () => {}
  const closed = new Promise<void>((resolve) => { settle = resolve })
  const finish = (): void => { release(); settle() }
  const maybeFinish = (): void => { if (readEnded && writeEnded) finish() }
  const readable = new ReadableStream<Uint8Array>({
    async pull (controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { readEnded = true; controller.close(); maybeFinish() } else controller.enqueue(value)
      } catch (error) {
        readEnded = true
        controller.error(error)
        maybeFinish()
      }
    },
    async cancel (reason) {
      readEnded = true
      await reader.cancel(reason).catch(() => {})
      maybeFinish()
    }
  }, { highWaterMark: 0 })
  const writable = new WritableStream<Uint8Array>({
    async write (chunk) {
      try {
        await writer.write(chunk)
      } catch (error) {
        writeEnded = true
        maybeFinish()
        throw error
      }
    },
    async close () {
      writeEnded = true
      await writer.close().catch(() => {})
      maybeFinish()
    },
    async abort (reason) {
      writeEnded = true
      await writer.abort(reason).catch(() => {})
      maybeFinish()
    }
  })
  return {
    id: `local-node-tcp-${randomUUID()}`,
    closed,
    close: async () => {
      await dialed.destroy('closed')
      finish()
    },
    readable,
    writable,
    remoteAddress: dialed.remoteAddress,
    remotePort: dialed.remotePort,
    localAddress: dialed.localAddress,
    localPort: dialed.localPort,
    setNoDelay: dialed.setNoDelay,
    setKeepAlive: dialed.setKeepAlive
  }
}

/** A name or a literal as the canonical public addresses it stands for. A name whose answers include one that is not public is refused whole. */
async function publicAddresses (host: string, lookup: NodeNetDeps['lookup']): Promise<string[]> {
  const literal = canonicalAddress(host)
  if (literal !== null) {
    if (!isPublicUnicast(literal)) throw fail('denied', 'the node reaches public addresses only')
    return [literal]
  }
  // An address-like or otherwise odd string that did not parse as an address (a scoped IPv6 address, say) is no name either.
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw fail('denied', 'the node reaches public addresses only')
  const answers = (await lookup(host)).slice(0, MAX_ANSWERS).map((answer) => canonicalAddress(answer.address))
  if (answers.length === 0) throw fail('unreachable', `could not resolve ${host}`)
  const checked: string[] = []
  for (const answer of answers) {
    if (answer === null || !isPublicUnicast(answer)) throw fail('denied', 'the node reaches public addresses only')
    checked.push(answer)
  }
  return checked
}

/** The canonical address a datagram to or from the resolver port may use, or null: a public unicast address, on port 53. */
function dnsPeer (address: string, port: number): string | null {
  const canonical = canonicalAddress(address)
  return port !== DNS_PORT || canonical === null || !isPublicUnicast(canonical) ? null : canonical
}

/** `source`'s datagrams, less those not from a public resolver address on port 53; each is counted in `dropped`. */
function fromResolversOnly (source: ReadableStream<Datagram>, dropped: { count: number }): ReadableStream<Datagram> {
  const reader = source.getReader()
  return new ReadableStream<Datagram>({
    async pull (controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { controller.close(); return }
        if (dnsPeer(value.address, value.port) !== null) { controller.enqueue(value); return }
        dropped.count += 1
      }
    },
    async cancel (reason) { await reader.cancel(reason) }
  }, { highWaterMark: 0 })
}

export interface NodeNetHooks {
  /** The listen on the API port itself failed: the node cannot serve, and the next start needs another port. */
  readonly apiPortTaken?: () => void
}

export function createNodeNet (apiPort: number, deps: NodeNetDeps = REAL, hooks: NodeNetHooks = {}): SocketNet {
  const sockets = new Budget(MAX_SOCKETS, 'sockets')
  const listeners = new Budget(MAX_LISTENERS, 'listeners')

  function serverHandle (listened: Awaited<ReturnType<Listen>>, release: () => void): TcpServer {
    let settle: () => void = () => {}
    const closed = new Promise<void>((resolve) => { settle = resolve })
    const finish = (): void => { release(); settle() }
    const connections = new ReadableStream<TcpSocket>({
      async pull (controller) {
        for (;;) {
          const accepted = await listened.accept().catch((error: unknown) => { controller.error(error); finish(); return undefined })
          if (accepted === undefined) return
          if (accepted === null) { controller.close(); finish(); return }
          let releaseSocket: () => void
          try {
            releaseSocket = sockets.take()
          } catch {
            await accepted.destroy('aborted')
            continue
          }
          controller.enqueue(socketHandle(accepted, releaseSocket))
          return
        }
      }
    }, { highWaterMark: 0 })
    return {
      id: `local-node-server-${randomUUID()}`,
      closed,
      close: async () => {
        await listened.destroy('closed')
        finish()
      },
      connections,
      localAddress: listened.localAddress,
      localPort: listened.localPort
    }
  }

  return {
    connect: async (options) => {
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw fail('invalid', 'not a port')
      const release = sockets.take()
      try {
        const addresses = await publicAddresses(options.host, deps.lookup)
        return socketHandle(await deps.dial(addresses, options.port, options.signal ?? new AbortController().signal), release)
      } catch (error) {
        release()
        throw error
      }
    },

    listen: async (options) => {
      const scope: BindScope = options.scope ?? 'local'
      if (scope !== 'local' || (options.port !== apiPort && options.port !== 0)) throw fail('denied', 'the node listens on loopback only: on its API port, or on a port the system picks')
      const release = listeners.take()
      try {
        return serverHandle(await deps.listen([{ lo: options.port, hi: options.port }], new AbortController().signal, 'local'), release)
      } catch (error) {
        release()
        if (options.port === apiPort) hooks.apiPortTaken?.()
        throw error
      }
    },

    udpBind: async (options) => {
      if (options.port !== 0) throw fail('denied', 'the node binds a datagram socket on an ephemeral port only')
      const release = sockets.take()
      try {
        const bound = await deps.bind([{ lo: 0, hi: 0 }], new AbortController().signal, options.scope ?? 'local')
        let refusalQueue: ReadableStreamDefaultController<SendRefusal> | undefined
        let droppedOutbound = 0
        const refusedInbound = { count: 0 }
        let settle: () => void = () => {}
        const closed = new Promise<void>((resolve) => { settle = resolve })
        const handle: UdpSocket = {
          id: `local-node-udp-${randomUUID()}`,
          closed,
          close: async () => {
            await bound.destroy('closed')
            release()
            settle()
          },
          readable: fromResolversOnly(bound.readable, refusedInbound),
          writable: new WritableStream<Datagram>({
            async write (datagram) {
              const peer = dnsPeer(datagram.address, datagram.port)
              if (peer === null) {
                droppedOutbound += 1
                if ((refusalQueue?.desiredSize ?? 0) > 0) refusalQueue?.enqueue({ address: datagram.address, port: datagram.port, code: 'denied' })
                return
              }
              if (!(await bound.send({ ...datagram, address: peer })).sent) droppedOutbound += 1
            }
          }),
          localAddress: bound.localAddress,
          localPort: bound.localPort,
          get droppedInbound () { return bound.droppedInbound + refusedInbound.count },
          get droppedOutbound () { return droppedOutbound },
          refusals: new ReadableStream<SendRefusal>({ start (controller) { refusalQueue = controller } }, { highWaterMark: REFUSAL_QUEUE })
        }
        return handle
      } catch (error) {
        release()
        throw error
      }
    },

    lookup: async (options) => (await deps.lookup(options.hostname)).slice(0, MAX_ANSWERS)
  }
}
