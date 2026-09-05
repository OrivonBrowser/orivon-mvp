// The write-side counterpart of ./port-pump-real-socket.test.ts: proves
// createPortSink against a real local TCP server and a real dialTcp()/
// Duplex.toWeb socket, not only the synthetic streams port-sink.test.ts
// drives. Two things only a real socket can prove: bytes the sink accepts
// actually reach a real peer, and a real peer reset reaches the sink's
// WriteFailedMessage with the genuine errno as platformCode (mirroring
// port-pump-real-socket's own case for the read direction).
//
// NOT COVERED HERE: half-close (a peer FIN leaving our writable open).
// open-questions.md A69 -- the fix that would make that true (allowHalfOpen)
// was found to break Duplex.toWeb's own EOF detection and was reverted, so
// asserting it here would test a property this tree does not actually have.

import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { dialTcp } from './node-adapters.js'
import { createPortSink } from './port-sink.js'
import { mapSocketError } from './socket-relay.js'
import type { WriteAckMessage, WriteFailedMessage } from '../contracts/ipc.js'

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

describe('createPortSink against a real local TCP server', () => {
  let server: Server
  let port: number
  let acceptedSockets: Socket[]

  function listen (): Promise<void> {
    acceptedSockets = []
    server = createServer((socket) => { acceptedSockets.push(socket) })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        port = typeof address === 'object' && address !== null ? address.port : 0
        resolve()
      })
    })
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  async function firstAccepted (): Promise<Socket> {
    for (let i = 0; i < 100 && acceptedSockets.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const socket = acceptedSockets[0]
    if (socket === undefined) throw new Error('server never accepted a connection')
    return socket
  }

  it('bytes accepted by the sink actually reach the real peer, and are acked', async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerReceived = new Promise<Buffer>((resolve) => peer.once('data', (chunk: Buffer) => { resolve(chunk) }))
    const sent: Array<WriteAckMessage | WriteFailedMessage> = []

    const sink = createPortSink({
      handleId: 'h1', writable: dialed.writable, send: (m) => { sent.push(m) }, windowBytes: 1_024
    })
    sink.handleWrite({ kind: 'write', handleId: 'h1', chunk: new Uint8Array([1, 2, 3, 4]) })

    expect(Array.from(await peerReceived)).toEqual([1, 2, 3, 4])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toContainEqual({ kind: 'write-ack', handleId: 'h1', bytesAccepted: 4 })

    await dialed.destroy('closed')
  }, 15_000)

  it('a real peer reset fails the pending write with reset and the genuine errno as platformCode', async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const sent: Array<WriteAckMessage | WriteFailedMessage> = []

    const sink = createPortSink({
      handleId: 'h1', writable: dialed.writable, send: (m) => { sent.push(m) }, windowBytes: 64 * 1024,
      mapError: mapSocketError
    })

    // Force the peer's kernel buffer to reject rather than accept: resetting
    // the connection is what makes our own pending/next write observe a real
    // ECONNRESET, the same way node-adapters.test.ts's "destroy('revoked')"
    // case proves the peer's side of this.
    peer.resetAndDestroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    sink.handleWrite({ kind: 'write', handleId: 'h1', chunk: new Uint8Array([9, 9, 9]) })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const failure = sent.find((m): m is WriteFailedMessage => m.kind === 'write-failed')
    expect(failure?.code).toBe('reset')
    expect(failure?.platformCode).toBe('ECONNRESET')
  }, 15_000)
})
