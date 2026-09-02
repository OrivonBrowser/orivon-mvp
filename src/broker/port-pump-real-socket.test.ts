// handle-contracts.md's conformance item 2, taken literally: "A TcpSocket
// whose read credit window is exhausted stops the broker from reading its
// underlying OS socket (verifiable by stalled recv on the native side)."
// Every other pump test (port-pump.test.ts) drives createPortPump against a
// synthetic ReadableStream, which proves the pump's own logic but not the
// literal claim -- a fake stream has no "native side" to stall. This file
// proves it against a real local TCP server and a real dialTcp()/Duplex.toWeb
// socket, the same style node-adapters.test.ts already uses for dialOne.
//
// The proof: once credit is exhausted, the pump stops calling reader.read(),
// so nothing drains the OS receive buffer for our socket. TCP's own flow
// control then backs up the PEER's send buffer -- observable as the server's
// own socket.write() returning false once its kernel buffer is genuinely
// full. That is what "stalled recv on the native side" means: not a log
// line, a real, externally observable stall.
//
// Checked empirically before writing this the naive way (writing-good-tests
// .md's own rule): a tight write() loop with no real gap between writes, or
// one paced only by setImmediate, never observes backpressure at all here --
// without a genuine event-loop tick, libuv never gets the chance to attempt
// the actual kernel write and report EAGAIN, so Node's own buffer accepts
// everything optimistically. A real setInterval-paced loop does, inside a
// few dozen 64KB writes.

import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp } from './node-adapters.js'
import { createPortPump } from './port-pump.js'
import type { DataMessage } from '../contracts/ipc.js'

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

const WINDOW = 64

/** Writes 64KB chunks on a real timer until the peer reports backpressure or `maxWrites` is hit. */
async function floodUntilBackpressure (peer: Socket, maxWrites = 200): Promise<{ sawBackpressure: boolean, bytesWritten: number }> {
  const chunk = Buffer.alloc(65536, 1)
  return await new Promise((resolve) => {
    let writes = 0
    const iv = setInterval(() => {
      const ok = peer.write(chunk)
      writes++
      if (!ok || writes >= maxWrites) {
        clearInterval(iv)
        resolve({ sawBackpressure: !ok, bytesWritten: peer.bytesWritten })
      }
    }, 5)
  })
}

describe('the credit window stalls a real OS socket, not only a synthetic stream', () => {
  let server: Server
  let port: number
  let serverSocket: Socket | undefined

  function listen (): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((socket) => { serverSocket = socket })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        port = typeof address === 'object' && address !== null ? address.port : 0
        resolve()
      })
    })
  }

  afterEach(async () => {
    serverSocket?.destroy()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  it("stops draining the socket, and the peer's own write() eventually reports real backpressure", async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const received: DataMessage[] = []
    createPortPump({
      handleId: 'h1',
      readable: dialed.readable,
      send: (m) => { if (m.kind === 'data') received.push(m) },
      initialCredit: WINDOW
    })

    for (let i = 0; i < 200 && serverSocket === undefined; i++) await new Promise((r) => setTimeout(r, 5))
    const { sawBackpressure } = await floodUntilBackpressure(serverSocket!)

    expect(sawBackpressure).toBe(true)
    // The pump only ever forwarded one window's worth (plus at most the one
    // chunk already in flight when credit ran out) -- not the megabytes the
    // server tried to push -- because it stopped calling reader.read().
    const totalReceived = received.reduce((n, m) => n + m.chunk.byteLength, 0)
    expect(totalReceived).toBeLessThan(WINDOW + 65536)

    await dialed.destroy('closed')
  }, 15_000)
})
