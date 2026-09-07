// `Bind` over real UDP -- the dgram sibling of ./node-adapters.ts's dialTcp,
// in its own file rather than appended to that one because the two share
// nothing but the word "socket" (a dgram.Socket is an EventEmitter, not a
// Duplex, so there is no Duplex.toWeb to lean on). Same purity stance: no
// `electron` import, so every test below runs against a real loopback socket.
//
// See ../README.md, Design notes, for why the inbound queue is charged a
// per-datagram FLOOR, and why `send` returns a value instead of throwing.

import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'
import type { Datagram, OrivonErrorCode } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'
import type { BoundUdpSocket, SendOutcome } from '../broker-contracts.js'
import type { PortRange } from '../policy/bind.js'
import { fail } from '../errors.js'

/** How many ports to try inside the granted ranges before giving up. */
const BIND_ATTEMPTS = 64

function errnoCode (error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
}

/**
 * A refused send. The key is OMITTED rather than set to undefined --
 * `exactOptionalPropertyTypes` is on, and `{ platformCode: undefined }` is not
 * the same value as `{}` once this crosses structured clone.
 */
function refused (code: OrivonErrorCode, platformCode?: string): SendOutcome {
  return platformCode === undefined ? { sent: false, code } : { sent: false, code, platformCode }
}

/** Total ports across `ranges`, as a bound for the random pick below. */
function countPorts (ranges: readonly PortRange[]): number {
  return ranges.reduce((total, range) => total + (range.hi - range.lo + 1), 0)
}

/** The `offset`-th port across `ranges`, treating them as one concatenated list. */
function portAt (ranges: readonly PortRange[], offset: number): number {
  let remaining = offset
  for (const range of ranges) {
    const width = range.hi - range.lo + 1
    if (remaining < width) return range.lo + remaining
    remaining -= width
  }
  // Unreachable: callers take `offset` modulo countPorts(ranges).
  throw fail('internal', 'port offset outside the granted ranges')
}

/**
 * One bind attempt. Resolves once the socket is listening, rejects on any
 * error -- including EADDRINUSE, which the caller retries against a different
 * port rather than treating as fatal.
 */
function bindOne (socket: DgramSocket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    socket.once('error', onError)
    socket.bind(port, '0.0.0.0', () => {
      socket.removeListener('error', onError)
      resolve()
    })
  })
}

/**
 * Wires a bound socket's inbound datagrams to a WHATWG readable, dropping
 * rather than queueing once the window is full.
 *
 * The drop lives HERE, at the one point where a datagram is either taken or
 * not, rather than in the relay: `controller.desiredSize` is the only honest
 * reading of how full the queue actually is, and a second drop point in the
 * relay would mean two places deciding the same thing.
 */
function readableOf (socket: DgramSocket, dropped: { count: number }, windowBytes: number): ReadableStream<Datagram> {
  return new ReadableStream<Datagram>({
    start (controller) {
      socket.on('message', (data, rinfo) => {
        // `> 0`, not `>= size`: WHATWG lets a queue overshoot its high-water
        // mark by the last chunk enqueued, so the real bound is the window
        // plus at most one maximum datagram. Accepted rather than papered
        // over -- refusing a datagram that would overshoot would mean a
        // 65507-byte packet is undeliverable whenever the queue is nearly
        // full, which is a worse failure than 64 KiB of slack.
        if (controller.desiredSize === null || controller.desiredSize <= 0) {
          dropped.count += 1
          return
        }
        controller.enqueue({
          data: new Uint8Array(data),
          address: rinfo.address,
          port: rinfo.port,
          family: rinfo.family === 'IPv6' ? 'IPv6' : 'IPv4'
        })
      })
      // A socket that dies under us must surface, or the relay reports a dead
      // socket as a quiet one -- the same failure port-pump.ts's
      // onStreamFailed exists to prevent on the TCP side.
      socket.on('error', (error: NodeJS.ErrnoException) => {
        controller.error(fail('internal', 'the UDP socket failed', undefined, error.code))
      })
    }
  }, {
    highWaterMark: windowBytes,
    // THE FLOOR IS WHAT MAKES ONE STRATEGY ENFORCE BOTH BOUNDS
    // (contracts/ipc.ts's DatagramCreditMessage). The high-water mark is the
    // byte bound; charging every datagram at least `window / count` means a
    // flood of tiny datagrams exhausts the byte budget after exactly
    // `inboundDatagramWindow` of them, so the count bound falls out of the
    // same arithmetic rather than needing a second check that can drift from
    // it. Derived from `windowBytes` rather than fixed, so an injected window
    // keeps its count bound instead of degrading to a pure byte bound.
    size: (datagram) => Math.max(datagram.data.byteLength, windowBytes / LIMITS.inboundDatagramWindow)
  })
}

/**
 * `Bind` over real UDP. Binds inside `ranges` and nowhere else.
 *
 * THE PORT IS PICKED AT RANDOM within the ranges, not sequentially from the
 * lowest. Sequential picking makes an app's port the same on every run, which
 * is a cheap cross-session fingerprint for a browser whose whole pitch is
 * privacy -- and it costs nothing to avoid (A88's own note).
 *
 * IPv4 ONLY in v0 (`udp4`, bound to 0.0.0.0). Nothing in the corpus specifies
 * the family, and a dual-stack `udp6` socket reports IPv4 peers as
 * IPv4-mapped addresses, which would have to be un-mapped before they could be
 * matched against a `udp.send` pattern -- a rebinding-shaped bug in the making
 * for no v0 benefit. Reversible: it is one option and a family field.
 */
export async function bindUdp (
  ranges: readonly PortRange[],
  signal: AbortSignal,
  windowBytes: number = LIMITS.inboundDatagramWindowBytes
): Promise<BoundUdpSocket> {
  if (signal.aborted) throw fail('revoked', 'the grant authorising this bind was withdrawn')
  const total = countPorts(ranges)
  if (total === 0) throw fail('internal', 'no granted port ranges to bind within')

  const socket = createSocket({ type: 'udp4' })
  const onAbort = (): void => { socket.close() }
  signal.addEventListener('abort', onAbort, { once: true })

  let lastError: unknown
  const start = Math.floor(Math.random() * total)
  for (let attempt = 0; attempt < Math.min(BIND_ATTEMPTS, total); attempt += 1) {
    try {
      await bindOne(socket, portAt(ranges, (start + attempt) % total))
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      if (signal.aborted) break
    }
  }

  signal.removeEventListener('abort', onAbort)
  if (signal.aborted) {
    socket.close()
    throw fail('revoked', 'the grant authorising this bind was withdrawn')
  }
  if (lastError !== undefined) {
    socket.close()
    // 'limit', not 'unreachable': every port the grant covers is taken, which
    // is a resource exhaustion the app can act on, not an unreachable peer.
    throw fail('limit', 'no free port in the granted range', undefined, errnoCode(lastError))
  }

  const address = socket.address()
  const dropped = { count: 0 }
  const readable = readableOf(socket, dropped, windowBytes)

  const bound: BoundUdpSocket = {
    readable,
    localAddress: address.address,
    localPort: address.port,
    get droppedInbound () { return dropped.count },
    send: async (datagram) => await sendOne(socket, datagram),
    // Every CloseReason closes the socket the same way. UDP is connectionless,
    // so there is no FIN to flush and no RST to send -- the whole close table
    // ../handles/handle-contracts.ts specifies for TCP collapses to one case
    // here, and pretending otherwise would be ceremony.
    destroy: async () => { await closeSocket(socket) }
  }
  return bound
}

async function sendOne (socket: DgramSocket, datagram: Datagram): Promise<SendOutcome> {
  if (datagram.data.byteLength > LIMITS.maxDatagramBytes) return refused('invalid')
  return await new Promise<SendOutcome>((resolve) => {
    try {
      socket.send(datagram.data, datagram.port, datagram.address, (error) => {
        resolve(error === null || error === undefined
          ? { sent: true }
          : refused('unreachable', errnoCode(error)))
      })
    } catch (error) {
      // socket.send throws SYNCHRONOUSLY on a closed socket and on a malformed
      // address, where the callback is never reached. Absorbed for the same
      // reason a callback error is: a throw out of here reaches the app's
      // writable, and erroring that stream is exactly what SendOutcome exists
      // to avoid.
      resolve(refused('invalid', errnoCode(error)))
    }
  })
}

function closeSocket (socket: DgramSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => { resolve() })
    } catch {
      // Already closed. `destroy` must settle exactly once and always
      // (../handles/handle-contracts.ts's DestroyResource), and a second close
      // throwing ERR_SOCKET_DGRAM_NOT_RUNNING is not a failure to report.
      resolve()
    }
  })
}
