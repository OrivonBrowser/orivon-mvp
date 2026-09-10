// Real, minimal Node adapters for createBroker's injected dependencies. No
// `electron` import anywhere here (dialTcp/dialOne/resolveHost need only
// node:net/node:dns; nodeFs needs only node:fs) -- src/broker/README.md's
// rule for this layer -- so every one of these is testable against a real
// temp directory and a real local TCP server, with no Electron and no
// mocking.

import { lookup } from 'node:dns/promises'
import { mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { connect as netConnect, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import type { CloseReason } from '../handles/handle-contracts.js'
import type { BrokerFs, Dial, DialedSocket, Listen, ListenedServer } from '../broker-contracts.js'
import type { PortRange } from '../policy/bind.js'
import { countPorts, portAt, randomStart } from './port-pick.js'
import { originHash } from '../grants/origin-hash.js'
import type { Resolver } from '../policy/connect.js'
import { fail, isOrivonErrorLike } from '../errors.js'

/**
 * `BrokerFs` over the real filesystem. `rootFor` is `./origin-hash.js`'s
 * `originHash(origin)` under `<userData>/apps/`, per ADR-0003 and
 * security-model.md T13b -- directory names must never be the literal
 * origin string, or `https://Example.com` and `https://example.com`
 * collide on a case-insensitive filesystem. `./origin-hash.js`'s own header
 * explains why this construction is shared with `partitionFor` rather than
 * inlined here.
 *
 * Takes `userDataPath` as a plain string rather than reaching for Electron's
 * `app` itself, so this adapter -- like `dialTcp`/`resolveHost`, which need
 * no Electron at all -- stays testable against a real temp directory without
 * needing Electron either.
 */
export function nodeFs (userDataPath: string): BrokerFs {
  return {
    // CREATES the root, it does not merely name it. confinePath's very first
    // act is realpath(root), and its own doc calls a root that will not
    // resolve "a broker bug, not an app's" -- so a root that has never been
    // created denies every path the app ever asks for, silently and always
    // (it fails closed, the same as a real traversal attempt, which is why
    // nothing catches it by symptom). Nothing else in the tree creates it:
    // writeFile's own mkdir runs on the confined path, only reached after
    // confinement has already refused.
    //
    // recursive: true makes this a no-op once the directory exists. It is a
    // blocking syscall on the broker's thread, in a function that already
    // hands confinePath a synchronous realpath (A28) -- whoever makes
    // realpath async should take this with it.
    rootFor: (origin) => {
      const root = join(userDataPath, 'apps', originHash(origin), 'files')
      mkdirSync(root, { recursive: true })
      return root
    },
    realpathSync,
    // NEITHER readFile NOR writeFile CATCHES. index.ts's `mapIoError` is the
    // one place an errno becomes an OrivonError; a catch here that produced
    // one instead would BYPASS that mapping, forwarding the confined
    // absolute path -- and through it the OS account name and the sha256
    // confinement root (T13b) -- to the app verbatim as an 'internal' error
    // rather than 'denied': the exact permission-probe oracle errors.ts's
    // uniformity rule exists to close. One implementation of this idea
    // (code-guidelines.md Rule 3).
    readFile: async (path) => {
      const buffer = await fsReadFile(path)
      // A COPY, not a zero-copy view over `buffer.buffer`. A Node Buffer is
      // a Uint8Array, but it can be a window into Node's shared allocation
      // pool (an 8KB slab holding unrelated data), and structured clone --
      // the path this value takes to the renderer -- serialises an
      // ArrayBufferView by serialising its WHOLE backing ArrayBuffer. See
      // README.md, Design notes, for why this is worth the memcpy even
      // though nothing observable leaks today.
      return new Uint8Array(buffer)
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true })
      await fsWriteFile(path, data)
    }
  }
}

function errnoCode (error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
}

/** `Resolver` over real DNS. A lookup failure is 'unreachable' (handle-contracts.md), not a broker fault. */
export const resolveHost: Resolver = async (host) => {
  try {
    const answers = await lookup(host, { all: true })
    return answers.map((answer) => answer.address)
  } catch (error) {
    throw fail('unreachable', `could not resolve ${host}`, undefined, errnoCode(error))
  }
}

/**
 * How long a clean close waits for queued bytes to reach the peer before the
 * socket is destroyed regardless.
 *
 * Without a deadline this path does not end: `socket.end(cb)` fires `cb` only
 * once every queued byte has drained into the peer's receive window, and a
 * peer that simply stops reading never lets that happen -- so the returned
 * promise, and the handle's own `closed`, never settle (open-questions.md
 * A84, reproduced in ./tests/socket-drain.test.ts).
 *
 * AI recommendation, not an owner decision: nothing in contracts/ or
 * handle-contracts.md specifies it. Matched to DIAL_TIMEOUT_MS above, on the
 * same reasoning -- long enough that a genuinely slow but working peer is
 * never cut off, short enough to bound an fd held for nothing.
 */
export const CLOSE_DRAIN_TIMEOUT_MS = 30_000

/**
 * Releases a real Node socket per handle-contracts.ts's CloseReason table:
 *
 *   'closed'/'sessionEnded'  FIN, buffered writes flushed -- socket.end()
 *                            waits for the flush before resolving.
 *   'revoked'/'aborted'      RST, buffered data discarded on both sides --
 *                            resetAndDestroy() is Node's explicit "send an
 *                            RST" API; destroy() alone does not guarantee
 *                            one. Same wire effect for both reasons; only
 *                            who initiated it differs (handle-contracts.ts).
 *   'failed'                 the resource is ALREADY GONE (handle-
 *                            contracts.ts's own CloseReason doc: "release
 *                            the fd and touch the wire not at all; a FIN
 *                            here is a write to a dead descriptor") -- so
 *                            neither end() nor resetAndDestroy(), just
 *                            destroy().
 */
export function destroySocket (
  socket: Socket,
  reason: CloseReason,
  drainTimeoutMs: number = CLOSE_DRAIN_TIMEOUT_MS
): Promise<void> {
  switch (reason) {
    case 'closed':
    case 'sessionEnded':
      return new Promise((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        function finish (destroy: boolean): void {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          // Only on the deadline. A socket that ended cleanly has already
          // sent its FIN, and destroying it afterwards is how a clean close
          // turns into an RST the peer reads as a failure.
          if (destroy) socket.destroy()
          resolve()
        }
        timer = setTimeout(() => { finish(true) }, drainTimeoutMs)
        timer.unref()
        socket.end(() => { finish(false) })
      })
    case 'revoked':
    case 'aborted':
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
      else socket.destroy()
      return Promise.resolve()
    case 'failed':
      socket.destroy()
      return Promise.resolve()
  }
}

/**
 * How long ONE dial attempt may run before it is abandoned. Node's own
 * `net.connect` has no timeout, and the only other bound in the path is
 * ipc.ts's `withTimeout`, which answers the CALLER but by its own doc does
 * not cancel the work -- so without this a connect to a blackholed address
 * held an fd and a per-origin in-flight slot for the OS SYN timeout (~130s on
 * Linux), and `dialTcp` walks its addresses sequentially, serialising that
 * cost per address.
 *
 * AI recommendation, not an owner decision: the value is not specified
 * anywhere in contracts/ or handle-contracts.md, and putting it in LIMITS
 * would be a src/contracts/ change that has to merge on its own.
 *
 * EXPORTED so ./tls-adapter.ts's own dial-and-handshake attempt reuses this
 * exact bound rather than a second copy of 30_000 that could drift from it.
 */
export const DIAL_TIMEOUT_MS = 30_000

/**
 * One dial attempt. `readable`/`writable` are real WHATWG streams
 * (`node:stream`'s `Duplex.toWeb`) so `DialedSocket`'s type is honestly
 * satisfied -- `broker.net.connect` cannot type-check otherwise -- even
 * though nothing on the control channel forwards them to a renderer
 * directly (../transport/port-pump.ts relays `readable`'s bytes over a
 * MessageChannelMain port instead; see ../transport/ipc.ts).
 */
function dialOne (address: string, port: number, signal: AbortSignal): Promise<DialedSocket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port })
    const onAbort = (): void => { socket.destroy() }
    signal.addEventListener('abort', onAbort, { once: true })
    let timer: NodeJS.Timeout
    const settle = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    timer = setTimeout(() => {
      settle()
      socket.destroy()
      reject(fail('timeout', `connecting to ${address}:${port} exceeded ${String(DIAL_TIMEOUT_MS)}ms`))
    }, DIAL_TIMEOUT_MS)
    timer.unref()

    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle()
      // A fresh message, not error.message -- Node's own carries the
      // address and port back verbatim, and index.ts's mapIoError only
      // rewrites messages for errors it maps itself, not ones already
      // shaped like an OrivonError (isOrivonErrorLike passes those through
      // unchanged). Matching resolveHost's pattern just above: the errno
      // survives as platformCode, the raw string does not.
      reject(fail('unreachable', `could not connect to ${address}:${port}`, undefined, error.code))
    })
    socket.once('connect', () => {
      settle()
      const { readable, writable } = Duplex.toWeb(socket)
      resolve({
        readable: readable as ReadableStream<Uint8Array>,
        writable: writable as WritableStream<Uint8Array>,
        remoteAddress: socket.remoteAddress ?? address,
        remotePort: socket.remotePort ?? port,
        localAddress: socket.localAddress ?? '',
        localPort: socket.localPort ?? 0,
        setNoDelay: async (on) => { socket.setNoDelay(on) },
        setKeepAlive: async (on, initialDelayMs) => { socket.setKeepAlive(on, initialDelayMs) },
        destroy: async (reason) => { await destroySocket(socket, reason) }
      })
    })
  })
}

/**
 * `Dial` over real TCP. Tries `addresses` in order, first success wins --
 * connect.ts hands over more than one literal so the caller can implement
 * its own fallback strategy across them (its header, and Node 24's default
 * `autoSelectFamily: true`). A SEQUENTIAL fallback rather than a parallel
 * happy-eyeballs race: simpler, and worth revisiting if connect latency to
 * dual-stack hosts ever matters.
 */
export const dialTcp: Dial = async (addresses, port, signal) => {
  if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')

  let lastError: unknown
  for (const address of addresses) {
    try {
      return await dialOne(address, port, signal)
    } catch (error) {
      lastError = error
      if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
    }
  }
  throw isOrivonErrorLike(lastError) ? lastError : fail('unreachable', 'could not connect to any resolved address')
}

/** How many ports to try inside the granted ranges before giving up. Matches bindUdp's own bound. */
const LISTEN_BIND_ATTEMPTS = 64

/**
 * How many accepted-but-not-yet-claimed connections one listening socket
 * holds before it refuses new ones outright, rather than queueing them
 * without limit.
 *
 * NOT THE SPECIFICATION'S OS-LEVEL BACKPRESSURE, and this is a real
 * deviation, flagged rather than smoothed over. handle-contracts.md's
 * conformance item 7 wants the OS listen backlog itself to apply pressure
 * once the app stops reading `connections` -- but vanilla Node `net` accepts
 * a connection and fires `'connection'` unconditionally the moment the OS
 * hands one over; there is no public API to defer the `accept()` syscall
 * itself independent of app readiness (checked against Node's own `lib/
 * net.js`, not assumed -- `pauseOnConnect` pauses an accepted SOCKET's data
 * flow, not the listener's accept loop). This bound is the fallback that
 * keeps an unread `connections` stream from pinning unbounded memory in the
 * main process regardless: past it, a new arrival is reset rather than
 * queued -- see ../README.md, Design notes, for the full reasoning and the
 * open question this is filed under.
 */
const LISTEN_ACCEPT_QUEUE_LIMIT = 64

interface AcceptWaiter {
  readonly resolve: (value: DialedSocket | null) => void
  readonly reject: (error: unknown) => void
}

/**
 * What a pending or future `accept()` resolves to for a given CloseReason --
 * shared by the waiter-settling code in `destroy()` and by `accept()` itself
 * for a call arriving after the server is already gone (Rule 3: one
 * implementation of "what does this reason mean to a caller", not two).
 *
 * 'closed'/'sessionEnded' are graceful: the app (or the session) chose to
 * stop, so `accept()` resolves null, the ReadableStream's own EOF signal.
 * Everything else is abrupt, and the CloseReason table
 * (../handles/handle-contracts.ts) requires "every promise the app is
 * currently awaiting on that handle" to REJECT with the terminal reason --
 * a pending `accept()` is exactly such a promise, and the generic handle-
 * table cascade has no reference to this ReadableStream's own pull promise
 * to reject it any other way.
 */
function outcomeFor (reason: CloseReason): { ok: true, value: null } | { ok: false, error: ReturnType<typeof fail> } {
  if (reason === 'closed' || reason === 'sessionEnded') return { ok: true, value: null }
  if (reason === 'failed') return { ok: false, error: fail('internal', 'the listening socket failed') }
  return { ok: false, error: fail('revoked', 'the grant authorising this listen was withdrawn') }
}

/**
 * Wraps a just-accepted raw socket the same way `dialOne` wraps a dialled
 * one -- same `Duplex.toWeb` construction, same `destroySocket` close table,
 * because an accepted connection and a dialled one are the same kind of
 * live TCP socket once established (handle-contracts.md's "TcpSocket"
 * section draws no distinction). Sharing `DialedSocket` as the shape for
 * both, rather than a second near-identical interface, is Rule 3 applied to
 * the type as well as the function.
 */
function wrapAccepted (socket: Socket): DialedSocket {
  const { readable, writable } = Duplex.toWeb(socket)
  return {
    readable: readable as ReadableStream<Uint8Array>,
    writable: writable as WritableStream<Uint8Array>,
    remoteAddress: socket.remoteAddress ?? '',
    remotePort: socket.remotePort ?? 0,
    localAddress: socket.localAddress ?? '',
    localPort: socket.localPort ?? 0,
    setNoDelay: async (on) => { socket.setNoDelay(on) },
    setKeepAlive: async (on, initialDelayMs) => { socket.setKeepAlive(on, initialDelayMs) },
    destroy: async (reason) => { await destroySocket(socket, reason) }
  }
}

/**
 * One listen attempt, on a fresh `net.Server` -- a new instance per attempt
 * rather than retrying `.listen()` on one, so a failed attempt never leaves
 * an ambiguous "is this instance still usable" question behind. Resolves
 * once listening, rejects on any error (including EADDRINUSE, which the
 * caller retries against a different port) -- same shape as
 * ./udp-adapter.ts's `bindOne`, and no `server.close()` call on the failure
 * path to match it: Node's own `_setupListenHandle` already releases the
 * fd before emitting `'error'` when a listen attempt fails, so this server
 * never held one to release.
 */
function listenOne (server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { server.removeListener('error', onError) }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    server.once('error', onError)
    server.listen(port, '0.0.0.0', () => { cleanup(); resolve() })
  })
}

/**
 * `Listen` over real TCP. Binds inside `ranges` and nowhere else, and picks
 * the port at random within them for the same reason `bindUdp` does (A88).
 *
 * IPv4 ONLY IN v0, matching `bindUdp`'s own scope note: nothing in the
 * corpus specifies dual-stack for a listening socket either, and `0.0.0.0`
 * keeps this half of `net.*` consistent with the other.
 */
export const listenTcp: Listen = async (ranges: readonly PortRange[], signal) => {
  if (signal.aborted) throw fail('revoked', 'the grant authorising this listen was withdrawn')
  const total = countPorts(ranges)
  if (total === 0) throw fail('internal', 'no granted port ranges to listen within')

  let server: Server | undefined
  let lastError: unknown
  const start = randomStart(total)
  const attempts = Math.min(LISTEN_BIND_ATTEMPTS, total)
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt += 1) {
    const candidate = createServer()
    try {
      await listenOne(candidate, portAt(ranges, (start + attempt) % total))
      server = candidate
      lastError = undefined
      break
    } catch (error) {
      lastError = error
    }
  }

  if (signal.aborted) {
    if (server !== undefined) await new Promise<void>((resolve) => { server!.close(() => resolve()) })
    throw fail('revoked', 'the grant authorising this listen was withdrawn')
  }
  if (server === undefined) {
    // 'limit', not 'unreachable': every port the grant covers is taken,
    // which is a resource exhaustion the app can act on -- matching
    // bindUdp's own reasoning for the UDP sibling of this failure.
    throw fail('limit', 'no free port in the granted range', undefined, errnoCode(lastError))
  }
  // A separate `const` from here on: `server` is a `let` narrowed above, and
  // TypeScript does not carry that narrowing into the closures below, which
  // may run long after this function returns.
  const bound = server

  const address = bound.address()
  if (address === null || typeof address === 'string') {
    bound.close()
    throw fail('internal', 'a listening TCP server reported no address')
  }

  const queue: Socket[] = []
  const waiters: AcceptWaiter[] = []
  let destroyed = false
  let terminalReason: CloseReason | undefined

  // Every not-yet-claimed raw connection below is torn down with the same
  // guaranteed-RST call `destroySocket`'s own 'revoked'/'aborted' branch
  // uses, for the same reason: plain `.destroy()` does not guarantee a wire
  // RST, only `resetAndDestroy()` does -- and a socket the app was never
  // told about is never worth a graceful FIN.
  function resetIncoming (socket: Socket): void {
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
    else socket.destroy()
  }

  bound.on('connection', (socket) => {
    if (destroyed) { resetIncoming(socket); return }
    const waiter = waiters.shift()
    if (waiter !== undefined) { waiter.resolve(wrapAccepted(socket)); return }
    if (queue.length >= LISTEN_ACCEPT_QUEUE_LIMIT) { resetIncoming(socket); return }
    queue.push(socket)
  })
  // The listening socket itself dying underneath us (EMFILE on a later
  // accept, for instance) must not vanish silently -- every waiter, and
  // every future accept(), is failed the same way an explicit destroy()
  // would fail them, per outcomeFor('failed').
  bound.on('error', () => {
    if (destroyed) return
    destroyed = true
    terminalReason = 'failed'
    for (const waiter of waiters.splice(0)) waiter.reject(fail('internal', 'the listening socket failed'))
    for (const queued of queue.splice(0)) resetIncoming(queued)
  })

  async function destroy (reason: CloseReason): Promise<void> {
    if (destroyed) return
    destroyed = true
    terminalReason = reason
    const outcome = outcomeFor(reason)
    for (const waiter of waiters.splice(0)) {
      if (outcome.ok) waiter.resolve(outcome.value)
      else waiter.reject(outcome.error)
    }
    // Never delivered to the app as a handle, so there is nothing here a
    // flushing reason could truncate -- unlike an established socket's own
    // write queue (../README.md's "unlink hook" design note), an unclaimed
    // raw connection is reset regardless of `reason`.
    for (const queued of queue.splice(0)) resetIncoming(queued)
    await new Promise<void>((resolve) => { bound.close(() => resolve()) })
  }

  function accept (): Promise<DialedSocket | null> {
    const queued = queue.shift()
    if (queued !== undefined) return Promise.resolve(wrapAccepted(queued))
    if (destroyed) {
      const outcome = outcomeFor(terminalReason ?? 'failed')
      return outcome.ok ? Promise.resolve(outcome.value) : Promise.reject(outcome.error)
    }
    return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
  }

  const listened: ListenedServer = {
    localAddress: address.address,
    localPort: address.port,
    accept,
    destroy
  }
  return listened
}
