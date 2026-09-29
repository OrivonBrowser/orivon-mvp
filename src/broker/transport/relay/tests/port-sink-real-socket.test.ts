// The write-side counterpart of ./port-pump-real-socket.test.ts: proves
// createPortSink against a real local TCP server and a real dialTcp()/
// ../../../adapters/socket-streams.ts socket, not only the synthetic streams
// port-sink.test.ts drives. Three things only a real socket can prove: bytes
// the sink accepts actually reach a real peer, a real peer reset reaches the
// sink's WriteFailedMessage with the genuine errno as platformCode
// (mirroring port-pump-real-socket's own case for the read direction), and
// the A69 half-close case below.
//
// A peer FIN still ends our writable early (allowHalfOpen: false) rather
// than leaving it open -- setting allowHalfOpen was found to break EOF
// detection on the read side and was reverted (docs/open-questions.md A69,
// still open). What changed is only how the write direction reports that
// when it happens: deterministically, from socket-streams.ts's own
// `socket.writable` check, not from sniffing an error Node's own web-stream
// adapter happened to produce.

import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialTcp } from '../../../adapters/node-adapters.js'
import { createPortSink } from '../port-sink.js'
import { mapSocketError } from '../socket.js'
import type { WriteAckMessage, WriteFailedMessage } from '../../../../contracts/ipc.js'

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

  it('handleAbort produces a real RST against a real peer when onAbort resets the underlying socket (B-F6)', async () => {
    // handle-contracts.md's close table specifies `writable.abort(e)` -> RST
    // sent, `closed` rejects 'reset'. writer.abort() alone cannot produce
    // that -- it calls the underlying duplex's plain destroy(), confirmed
    // empirically (Node 24.11.1) to send a clean FIN, not an RST. The real
    // reset has to happen at the raw socket level, which is exactly what
    // `onAbort` is for: production wires it to HandleTable.abort, which
    // tells node-adapters.ts's destroySocket to use the 'aborted' reason
    // (resetAndDestroy()) -- modelled here by wiring it straight to this
    // socket's own destroy().
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const peerErrored = new Promise<NodeJS.ErrnoException>((resolve) => { peer.once('error', resolve) })
    const peerClosed = new Promise<boolean>((resolve) => { peer.once('close', (hadError) => { resolve(hadError) }) })

    const sink = createPortSink({
      handleId: 'h1',
      writable: dialed.writable,
      send: () => {},
      windowBytes: 1_024,
      onAbort: () => { void dialed.destroy('aborted') }
    })
    sink.handleAbort({ kind: 'write-abort', handleId: 'h1' })

    const error = await peerErrored
    expect(error.code).toBe('ECONNRESET')
    expect(await peerClosed).toBe(true)
  }, 15_000)

  it('a peer FIN auto-ending our writable (A69) fails only the write direction, not the whole handle', async () => {
    await listen()
    const dialed = await dialTcp(['127.0.0.1'], port, neverAborts())
    const peer = await firstAccepted()
    const sent: Array<WriteAckMessage | WriteFailedMessage> = []
    const onSinkFailed = vi.fn()

    const sink = createPortSink({
      handleId: 'h1', writable: dialed.writable, send: (m) => { sent.push(m) }, windowBytes: 1_024,
      mapError: mapSocketError, onSinkFailed
    })

    peer.end()
    // Give allowHalfOpen: false time to actually auto-end our writable --
    // node-adapters.test.ts's own probe confirms this needs a real tick, not
    // just the 'end' event, on this Node version.
    await new Promise((resolve) => setTimeout(resolve, 30))

    sink.handleWrite({ kind: 'write', handleId: 'h1', chunk: new Uint8Array([1, 2, 3]) })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(sent).toEqual([{ kind: 'write-failed', handleId: 'h1', code: 'closed' }])
    expect(onSinkFailed).not.toHaveBeenCalled()

    await dialed.destroy('failed')
  }, 15_000)
})
