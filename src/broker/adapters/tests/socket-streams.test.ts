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

import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp } from '../node-adapters.js'
import { WRITABLE_ALREADY_ENDED_CODE } from '../socket-streams.js'

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

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
    const resetServer = createServer((socket) => { socket.resetAndDestroy() })
    await new Promise<void>((resolve) => { resetServer.listen(0, '127.0.0.1', () => resolve()) })
    const resetPort = (resetServer.address() as { port: number }).port

    const closeServer = createServer((socket) => { socket.end() })
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
