// destroySocket's drain deadline (open-questions.md A84, fix shape (a)).
//
// A clean close is a half-close: socket.end(cb) fires cb only once every
// queued byte has drained into the peer's receive window. A peer that stops
// reading never lets that happen, so without a deadline the returned promise
// never settles and the handle's `closed` never resolves. The real-socket
// case at the bottom is the reproduction A84 recorded, run here rather than
// described.

import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_DRAIN_TIMEOUT_MS, destroySocket } from './node-adapters.js'

/** A Socket-shaped double whose `end` callback never fires -- the peer that never drains. */
function stuckSocket (): { socket: Socket, destroyed: () => boolean } {
  let destroyed = false
  const socket = {
    end: (_cb?: () => void) => socket,
    destroy: () => { destroyed = true; return socket },
    resetAndDestroy: () => { destroyed = true; return socket }
  } as unknown as Socket
  return { socket, destroyed: () => destroyed }
}

describe('destroySocket -- the drain deadline', () => {
  afterEach(() => { vi.useRealTimers() })

  it('settles and destroys the socket when the peer never drains', async () => {
    vi.useFakeTimers()
    const { socket, destroyed } = stuckSocket()

    const settled = destroySocket(socket, 'closed')
    await vi.advanceTimersByTimeAsync(CLOSE_DRAIN_TIMEOUT_MS)
    await settled

    expect(destroyed()).toBe(true)
  })

  it('does not wait for the deadline when the peer does drain', async () => {
    vi.useFakeTimers()
    let destroyed = false
    const socket = {
      end: (cb?: () => void) => { cb?.(); return socket },
      destroy: () => { destroyed = true; return socket }
    } as unknown as Socket

    await destroySocket(socket, 'closed')

    // The clean path must not reach for destroy() at all: a socket that
    // ended cleanly has already sent its FIN, and destroying it afterwards
    // is how a clean close turns into an RST the peer misreads.
    expect(destroyed).toBe(false)
  })

  it('applies to sessionEnded as well -- the same half-close, the same peer', async () => {
    vi.useFakeTimers()
    const { socket, destroyed } = stuckSocket()

    const settled = destroySocket(socket, 'sessionEnded')
    await vi.advanceTimersByTimeAsync(CLOSE_DRAIN_TIMEOUT_MS)
    await settled

    expect(destroyed()).toBe(true)
  })

  it('leaves revoked and aborted on their existing immediate-reset path', async () => {
    const { socket, destroyed } = stuckSocket()

    await destroySocket(socket, 'revoked')

    expect(destroyed()).toBe(true)
  })
})

describe('destroySocket against a real non-draining peer', () => {
  let server: Server
  let port: number
  const accepted: Socket[] = []

  afterEach(async () => {
    for (const socket of accepted) socket.destroy()
    accepted.length = 0
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  })

  function listenPaused (): Promise<void> {
    // The exact peer A84 reproduced against: accepts, then never reads.
    server = createServer((socket) => {
      socket.pause()
      // Both ends are torn down mid-transfer by design here, so both see a
      // reset. Unhandled, Node turns that into an uncaught exception that
      // fails the whole file rather than this test.
      socket.on('error', () => {})
      accepted.push(socket)
    })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        port = typeof address === 'object' && address !== null ? address.port : 0
        resolve()
      })
    })
  }

  it('settles, rather than hanging forever, with megabytes still queued', async () => {
    await listenPaused()
    const socket = netConnect({ host: '127.0.0.1', port })
    socket.on('error', () => {})
    await new Promise<void>((resolve) => { socket.once('connect', () => { resolve() }) })

    // Enough to overrun the peer's receive window several times over, so
    // end()'s own callback genuinely cannot fire.
    while (socket.writableLength < 4 * 1024 * 1024) socket.write(Buffer.alloc(64 * 1024))
    expect(socket.writableLength).toBeGreaterThan(1024 * 1024)

    await destroySocket(socket, 'closed', 250)

    expect(socket.destroyed).toBe(true)
  })
})
