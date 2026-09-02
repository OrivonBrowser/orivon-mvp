// Real, minimal Node adapters for createBroker's injected dependencies.
// src/broker/README.md: "Anything with an import of electron belongs one
// level up [from policy/], in src/broker/" -- this file has no `electron`
// import at all (dialTcp/dialOne/resolveHost need only node:net/node:dns;
// nodeFs needs only node:fs), so every one of these stays testable against
// a real temp directory and a real local TCP server, with no Electron and
// no mocking.
//
// Split out of ./ipc.ts (docs/development/code-guidelines.md Rule 2) when
// the byte-pump task's net.connect/net.close wiring pushed that file over
// its 500-line budget. No behaviour changed by the split itself; dialOne's
// destroy became reason-aware in the same commit -- that IS new behaviour,
// covered by this file's own tests, not carried over silently.

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { realpathSync } from 'node:fs'
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import type { CloseReason } from './handle-contracts.js'
import type { BrokerFs, Dial, DialedSocket } from './index.js'
import type { Resolver } from './policy/connect.js'
import { fail, isOrivonErrorLike } from './errors.js'

/**
 * `BrokerFs` over the real filesystem. `rootFor` is `sha256(origin)` under
 * `<userData>/apps/`, per ADR-0003 and security-model.md T13b -- directory
 * names must never be the literal origin string, or `https://Example.com`
 * and `https://example.com` collide on a case-insensitive filesystem.
 *
 * Takes `userDataPath` as a plain string rather than reaching for Electron's
 * `app` itself, so this adapter -- like `dialTcp`/`resolveHost`, which need
 * no Electron at all -- stays testable against a real temp directory without
 * needing Electron either.
 */
export function nodeFs (userDataPath: string): BrokerFs {
  return {
    rootFor: (origin) => join(userDataPath, 'apps', createHash('sha256').update(origin, 'utf8').digest('hex'), 'files'),
    realpathSync,
    // NEITHER readFile NOR writeFile CATCHES. index.ts's `mapIoError` is the
    // one place an errno becomes an OrivonError, and it only rewrites errors
    // it maps ITSELF -- `isOrivonError(error) return error` passes an
    // already-shaped one straight through. So a catch here that produced an
    // OrivonError did not add mapping, it BYPASSED it: the message this file
    // built (which named the confined absolute path, and through it the OS
    // account name and the sha256 confinement root -- T13b, exactly what
    // mapIoError's own doc comment says it exists to withhold) was forwarded
    // to the app verbatim, and EACCES/EPERM never reached
    // ERRNO_TO_CODE's 'denied' mapping, crossing instead as
    // 'internal' + platformCode: 'EACCES' -- the permission-probe oracle
    // errors.ts's uniformity rule exists to close.
    //
    // Two implementations of one idea, and the wrong one won
    // (code-guidelines.md Rule 3). This is now the only one.
    readFile: async (path) => {
      const buffer = await fsReadFile(path)
      // A COPY, not a zero-copy view over `buffer.buffer`. A Node Buffer is
      // a Uint8Array, but it can be a window into Node's shared allocation
      // pool (an 8KB slab holding unrelated data), and structured clone --
      // the path this value takes to the renderer -- serialises an
      // ArrayBufferView by serialising its WHOLE backing ArrayBuffer. A
      // pooled view would therefore hand the page bytes it never read,
      // recoverable as `new Uint8Array(result.buffer)`.
      //
      // fs/promises.readFile happens to allocate exact-size today, so the
      // view was not actually leaking; that is an unspecified Node
      // implementation detail, not a guarantee, and readFileSync and
      // Buffer.allocUnsafe both pool at this size. Copying costs one memcpy
      // and removes the dependence entirely.
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
 * Releases a real Node socket per handle-contracts.ts's CloseReason table --
 * the table this file's own dialOne doc comment used to say was not yet
 * implemented ("the byte-pump task owns the real table"). This is that task.
 *
 *   'closed'/'sessionEnded'  FIN, buffered writes flushed -- socket.end()
 *                            waits for the flush before resolving.
 *   'revoked'                RST, buffered data discarded on both sides --
 *                            resetAndDestroy() is Node's explicit "send an
 *                            RST" API; destroy() alone does not guarantee
 *                            one.
 *   'failed'                 the resource is ALREADY GONE (handle-
 *                            contracts.ts's own CloseReason doc: "release
 *                            the fd and touch the wire not at all; a FIN
 *                            here is a write to a dead descriptor") -- so
 *                            neither end() nor resetAndDestroy(), just
 *                            destroy().
 */
function destroySocket (socket: Socket, reason: CloseReason): Promise<void> {
  switch (reason) {
    case 'closed':
    case 'sessionEnded':
      return new Promise((resolve) => { socket.end(() => { resolve() }) })
    case 'revoked':
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
      else socket.destroy()
      return Promise.resolve()
    case 'failed':
      socket.destroy()
      return Promise.resolve()
  }
}

/**
 * One dial attempt. `readable`/`writable` are real WHATWG streams
 * (`node:stream`'s `Duplex.toWeb`) so `DialedSocket`'s type is honestly
 * satisfied -- `broker.net.connect` cannot type-check otherwise -- even
 * though nothing on the control channel forwards them to a renderer
 * directly (./port-pump.ts relays `readable`'s bytes over a
 * MessageChannelMain port instead; see ./ipc.ts).
 */
function dialOne (address: string, port: number, signal: AbortSignal): Promise<DialedSocket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port })
    const onAbort = (): void => { socket.destroy() }
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => { signal.removeEventListener('abort', onAbort) }

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
 * happy-eyeballs race: simpler, and correct for the control-channel wiring
 * this task is about. Flagged in the PR as a simplification worth revisiting
 * if connect latency to dual-stack hosts ever matters.
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
