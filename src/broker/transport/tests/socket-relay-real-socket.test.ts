// createSocketRelay against a real local TCP server and a real dialTcp()/
// Duplex.toWeb socket: proves that a clean end in both directions is
// actually observed on a real socket (the peer's FIN ends the readable, the
// app's write-end issues ours) and releases the handle, which the synthetic
// streams in socket-relay.test.ts can only assume.

import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialTcp } from '../../adapters/node-adapters.js'
import { createSocketRelay } from '../socket-relay.js'
import { createPortRegistry } from '../port-registry.js'
import type { RegisteredSocket } from '../port-transport.js'
import type { FailableTcpSocket } from '../../handles/handle-contracts.js'
import { fakePort } from './ipc.test-helpers.js'

describe('createSocketRelay against a real local TCP server', () => {
  let server: Server
  const accepted: Socket[] = []

  afterEach(async () => {
    for (const socket of accepted.splice(0)) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  async function listen (): Promise<number> {
    server = createServer((socket) => { accepted.push(socket) })
    return await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  }

  async function until (condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('the app ending its side and the peer ending its own releases the handle', async () => {
    const dialed = await dialTcp(['127.0.0.1'], await listen(), new AbortController().signal)
    await until(() => accepted.length > 0)
    const peer = accepted[0]
    if (peer === undefined) throw new Error('server never accepted a connection')
    const peerSawEnd = new Promise<void>((resolve) => { peer.on('end', () => { resolve() }); peer.resume() })

    const close = vi.fn(async () => { await dialed.destroy('closed') })
    const socket: FailableTcpSocket = {
      ...dialed,
      id: 'handle-1',
      closed: new Promise<void>(() => {}),
      close,
      fail: () => {},
      abort: () => {},
      onUnlink: () => {}
    }
    const port = fakePort()
    createSocketRelay({ origin: 'https://app.example', socket, port, registry: createPortRegistry<RegisteredSocket>(), readWindowBytes: 1_024, writeWindowBytes: 1_024 })

    port.emit({ kind: 'write-end', handleId: 'handle-1' })
    await peerSawEnd
    expect(close).not.toHaveBeenCalled()

    peer.end()
    await until(() => close.mock.calls.length > 0)

    expect(close).toHaveBeenCalledTimes(1)
    expect(port.sent).toContainEqual({ kind: 'end', handleId: 'handle-1' })
  }, 15_000)
})
