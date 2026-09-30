// ./socket-streams.ts's own suite: the hand-written WHATWG-stream wrapping
// that replaced `Duplex.toWeb` in ../node-adapters.ts's dialOne/wrapAccepted
// (README.md's Design notes -- nodejs/node#63761). Basic data-flow/EOF/error
// correctness first, then the concurrency stress test (G3's own repro
// shape): many real dials against a peer that resets, closes or refuses,
// with reader.cancel()/writer.abort()/DialedSocket.destroy() racing in every
// order, asserting the process never takes an uncaughtException. This
// specific sequence did not reproduce nodejs/node#63761's TypeError against
// the OLD Duplex.toWeb-based adapter either, in tens of thousands of runs
// across several timing variations (matching that bug's own reporter, who
// could not isolate a repro outside their real application) -- so this test
// cannot prove the old crash is gone. What it does prove: the new adapter,
// which no longer executes any of node:internal/webstreams/adapters.js's
// `finished()`-driven code at all, survives the same churn.

import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp } from '../node-adapters.js'
import { socketReadable, socketWritable, WRITABLE_ALREADY_ENDED_CODE } from '../socket-streams.js'

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

/** A Socket-shaped double, real enough for socketReadable: an EventEmitter with the few methods it calls. */
class FakeReadableSocket extends EventEmitter {
  readableHighWaterMark = 64 * 1024
  pause (): this { return this }
  resume (): this { return this }
  destroy (): this { return this }
}

function fakeSocket (): Socket {
  return new FakeReadableSocket() as unknown as Socket
}

describe('socketReadable -- chunk copying', () => {
  it('copies a data chunk rather than exposing a view over its own backing buffer', async () => {
    const socket = fakeSocket()
    const reader = socketReadable(socket).getReader()

    // A pooled/shared allocation: the chunk 'data' hands over is a VIEW into
    // a LARGER buffer with real neighbouring bytes on both sides -- the shape
    // a future Node/Electron read buffer could take (this Node version
    // always allocates exact-size, so this double is what stands in for
    // "future").
    const pool = Buffer.alloc(16, 0xff)
    const chunk = pool.subarray(4, 8)
    chunk.fill(1)
    socket.emit('data', chunk)
    const { value } = await reader.read()
    expect(Array.from(value ?? [])).toEqual([1, 1, 1, 1])

    // A view would let this reach bytes the renderer already "received":
    // mutating the pool afterwards must never change what was already read.
    pool.fill(0xee)
    expect(Array.from(value ?? [])).toEqual([1, 1, 1, 1])
  })
})

/** A Socket-shaped double whose write() always tells the kernel to accept immediately, deferring its flush callback until flush() is called by hand. */
function fakeWritableSocket (): { socket: Socket, flush: () => void } {
  const deferred: Array<() => void> = []
  class FakeWritableSocket extends EventEmitter {
    writable = true
    writableHighWaterMark = 64 * 1024
    write (_chunk: unknown, cb?: (error?: Error) => void): boolean {
      if (cb !== undefined) deferred.push(cb)
      return true
    }

    end (cb?: (error?: Error) => void): this { cb?.(); return this }
  }
  const socket = new FakeWritableSocket()
  return { socket: socket as unknown as Socket, flush: () => { while (deferred.length > 0) deferred.shift()?.() } }
}

describe('socketWritable -- pipelining', () => {
  it('resolves a write once the kernel accepts it, not once its own flush callback fires', async () => {
    const { socket, flush } = fakeWritableSocket()
    const writer = socketWritable(socket).getWriter()

    const writes = Promise.all([1, 2, 3, 4, 5].map(async (n) => { await writer.write(new Uint8Array([n])) }))

    // flush() is never called in this test: the flush callback stays
    // pending forever. Waiting for it (as the old code did, one write at a
    // time) would leave `writes` unsettled -- resolving on socket.write()'s
    // own return value instead is what lets every write settle regardless.
    await expect(Promise.race([writes, new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200))]))
      .resolves.not.toBe('timed-out')

    flush() // drains the never-needed callbacks so nothing here leaks a timer
  })
})

describe('socketReadable / socketWritable -- basic correctness', () => {
  let server: Server
  let port: number

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it('delivers bytes the peer writes, in order, and reports a clean peer FIN as EOF', async () => {
    server = createServer((socket) => {
      socket.write(Buffer.from([1, 2, 3]))
      socket.end()
    })
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const reader = dialed.readable.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    expect(Array.from(chunks[0] ?? [])).toEqual([1, 2, 3])
    await dialed.destroy('failed')
  })

  it('errors the readable with the real errno when the peer resets', async () => {
    // setImmediate, not a same-tick resetAndDestroy: the client's own
    // 'connect' must fire first, or the reset reaches dialOne's own
    // connect-error path instead of the read this test means to exercise
    // (node-adapters.test.ts's own dial tests already cover that path).
    server = createServer((socket) => { setImmediate(() => { socket.resetAndDestroy() }) })
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const reader = dialed.readable.getReader()
    await expect(reader.read()).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('rejects a write after the peer FIN auto-ended our writable with WRITABLE_ALREADY_ENDED_CODE', async () => {
    server = createServer((socket) => { socket.end() })
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const reader = dialed.readable.getReader()
    await reader.read() // waits for the peer's FIN (done: true)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const writer = dialed.writable.getWriter()
    await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({ code: WRITABLE_ALREADY_ENDED_CODE })
    await dialed.destroy('failed')
  })

  it('a local destroy() with no error and no prior end/error reports the readable as a clean end, not an AbortError', async () => {
    // The one real caller that reaches this: node-adapters.ts's destroySocket
    // drain-deadline timeout, which always resolves for 'closed'/'sessionEnded'
    // regardless -- so the read side reporting a clean end here matches an
    // already-successful close, rather than turning it into a spurious
    // failure the way copying Duplex.toWeb's old AbortError-on-destroy
    // behaviour would.
    server = createServer(() => {}) // accepts and does nothing: never ends, never errors
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const reader = dialed.readable.getReader()
    const readPromise = reader.read()

    // Neither the peer nor our own reader ever ends this socket -- only the
    // raw destroy() below does, with no error, exactly as destroySocket's
    // deadline path calls it.
    await dialed.destroy('failed')

    await expect(readPromise).resolves.toEqual({ done: true, value: undefined })
  })

  it('reader.cancel() destroys the whole socket, matching the load-bearing Duplex.toWeb behaviour socket.ts depends on', async () => {
    const accepted: Array<{ closed: Promise<void> }> = []
    server = createServer((socket) => {
      accepted.push({ closed: new Promise((resolve) => socket.once('close', () => resolve())) })
    })
    port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const reader = dialed.readable.getReader()
    void reader.read()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // cancel() alone -- no destroy()/close() call of our own -- must be
    // enough to tear the connection down all the way to the real peer.
    await reader.cancel(new Error('discarded'))
    await accepted[0]?.closed
  })
})

describe('socketReadable / socketWritable under concurrent teardown churn (G3)', () => {
  it('never throws an uncaughtException across many concurrent dial/cancel/abort/destroy sequences', async () => {
    // The peers are this test's own: a dial that resets before the server's accept callback runs
    // hands that callback a connection already reset, and its socket reports ECONNRESET. Only a
    // socket the code under test owns may count as an uncaught exception here.
    const peerErrors = (socket: Socket): void => { socket.on('error', () => {}) }
    const resetServer = createServer((socket) => { peerErrors(socket); socket.resetAndDestroy() })
    await new Promise<void>((resolve) => { resetServer.listen(0, '127.0.0.1', () => resolve()) })
    const resetPort = (resetServer.address() as { port: number }).port

    const closeServer = createServer((socket) => { peerErrors(socket); socket.end() })
    await new Promise<void>((resolve) => { closeServer.listen(0, '127.0.0.1', () => resolve()) })
    const closePort = (closeServer.address() as { port: number }).port

    const refusedPort = 65503 // nothing listening here

    let crashed: unknown = null
    const onUncaught = (error: unknown): void => { if (crashed === null) crashed = error }
    process.on('uncaughtException', onUncaught)

    const jitter = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)))

    async function oneAttempt (mode: number): Promise<void> {
      const targets = [resetPort, closePort, refusedPort]
      const port = targets[mode % 3] ?? refusedPort
      let dialed
      try {
        dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
      } catch {
        return // 'refused' -- expected, nothing to tear down
      }
      const reader = dialed.readable.getReader()
      const writer = dialed.writable.getWriter()
      reader.read().catch(() => {})
      writer.write(new Uint8Array([1, 2, 3])).catch(() => {})

      const reason = new Error('write-abort')
      const ops: Array<() => void> = [
        () => { reader.cancel(reason).catch(() => {}) },
        () => { writer.abort(reason).catch(() => {}) },
        () => { void dialed.destroy(mode % 2 === 0 ? 'revoked' : 'closed') },
        () => { writer.write(new Uint8Array([4, 5, 6])).catch(() => {}) }
      ]
      const orders = [
        [0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 2, 0], [0, 3, 2, 1], [2, 0, 3, 1], [1, 0, 3, 2]
      ]
      for (const idx of orders[mode % orders.length] ?? []) {
        ops[idx]?.()
        if (Math.random() < 0.5) await jitter()
      }
      await jitter()
    }

    const total = 4000
    const concurrency = 100
    for (let i = 0; i < total && crashed === null; i += concurrency) {
      const batch = []
      for (let j = 0; j < concurrency; j++) batch.push(oneAttempt(i + j))
      await Promise.all(batch)
    }

    process.removeListener('uncaughtException', onUncaught)
    resetServer.close()
    closeServer.close()

    if (crashed !== null) throw crashed
  }, 60_000)
})
