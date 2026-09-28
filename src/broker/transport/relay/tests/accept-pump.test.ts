import { describe, expect, it, vi } from 'vitest'
import { createAcceptPump } from '../accept-pump.js'
import type { StreamEndMessage } from '../../../../contracts/ipc.js'
import type { FailableTcpSocket } from '../../../handles/handle-contracts.js'

const HANDLE = 'server-1'

function fakeAccepted (id: string): FailableTcpSocket {
  // Only `id` is ever inspected by these tests -- createAcceptPump treats an
  // accepted connection as an opaque item, exactly as ../server.ts's own
  // onAccepted (which does the real work) expects.
  return { id } as FailableTcpSocket
}

// highWaterMark: 0 ON EVERY STREAM BELOW, matching capabilities/net.ts's own
// `entry.connections` exactly (handle-contracts.md's "TcpServer" section) --
// without it, a default ReadableStream's own queuing strategy eagerly pulls
// ONE item ahead at construction, which would silently defeat the very
// "unread server accepts none" property this file's first describe block
// exists to prove.

/** A connections stream that enqueues `items` one per pull(), then closes. */
function connectionStream (items: FailableTcpSocket[], onPull?: () => void): ReadableStream<FailableTcpSocket> {
  let i = 0
  return new ReadableStream<FailableTcpSocket>({
    pull (controller) {
      onPull?.()
      const next = items[i]
      if (next !== undefined) {
        controller.enqueue(next)
        i++
      } else {
        controller.close()
      }
    }
  }, { highWaterMark: 0 })
}

/** A connections stream that enqueues `items`, then errors instead of closing -- mirrors capabilities/net.ts's own pull(), which maps a raw accept() failure to an OrivonError before erroring. */
function erroringConnectionStream (items: FailableTcpSocket[], error: unknown): ReadableStream<FailableTcpSocket> {
  let i = 0
  return new ReadableStream<FailableTcpSocket>({
    pull (controller) {
      const next = items[i]
      if (next !== undefined) {
        controller.enqueue(next)
        i++
      } else {
        controller.error(error)
      }
    }
  }, { highWaterMark: 0 })
}

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function credit (units: number, handleId = HANDLE): { kind: 'credit', handleId: string, bytesConsumed: number } {
  return { kind: 'credit', handleId, bytesConsumed: units }
}

describe('createAcceptPump -- never reads ahead of demand', () => {
  it('accepts nothing until demand arrives -- an unread server accepts none', async () => {
    const onAccepted = vi.fn()
    let pulls = 0
    createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a')], () => { pulls++ }),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    })

    await tick()

    expect(onAccepted).not.toHaveBeenCalled()
    expect(pulls).toBe(0)
  })

  it('accepts exactly one connection per unit of demand -- N reads accept exactly N connections', async () => {
    const onAccepted = vi.fn()
    const pump = createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a'), fakeAccepted('b'), fakeAccepted('c')]),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    })

    pump.handleDemand(credit(1))
    await tick()
    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(onAccepted).toHaveBeenCalledWith(fakeAccepted('a'))

    pump.handleDemand(credit(1))
    await tick()
    expect(onAccepted).toHaveBeenCalledTimes(2)
    expect(onAccepted).toHaveBeenLastCalledWith(fakeAccepted('b'))

    // A third unit of demand must not also pull the fourth item -- there is
    // no fourth item, so this would surface as a third onAccepted call for
    // something that does not exist.
    pump.handleDemand(credit(1))
    await tick()
    expect(onAccepted).toHaveBeenCalledTimes(3)
    expect(onAccepted).toHaveBeenLastCalledWith(fakeAccepted('c'))
  })

  it('one demand message worth several units accepts that many connections, not just one', async () => {
    const onAccepted = vi.fn()
    createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a'), fakeAccepted('b')]),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    }).handleDemand(credit(2))

    await tick()

    expect(onAccepted).toHaveBeenCalledTimes(2)
  })

  it('ignores a demand message addressed to a different handle', async () => {
    const onAccepted = vi.fn()
    createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a')]),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    }).handleDemand(credit(1, 'some-other-handle'))

    await tick()

    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('ignores a non-positive or non-finite demand figure', async () => {
    const onAccepted = vi.fn()
    const pump = createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a')]),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    })

    pump.handleDemand(credit(0))
    pump.handleDemand(credit(-1))
    pump.handleDemand(credit(Number.NaN))
    pump.handleDemand(credit(Number.POSITIVE_INFINITY))
    await tick()

    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('clamps accumulated demand at maxOutstandingDemand, not letting a large claim accept past the ceiling', async () => {
    const onAccepted = vi.fn()
    const items = Array.from({ length: 10 }, (_, i) => fakeAccepted(`c${i}`))
    createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream(items),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 3
    }).handleDemand(credit(1_000_000))

    await tick(20)

    expect(onAccepted).toHaveBeenCalledTimes(3)
  })
})

describe('createAcceptPump -- terminal states', () => {
  it('sends exactly one clean end message (no code) once connections closes gracefully', async () => {
    const send = vi.fn()
    createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([]),
      onAccepted: vi.fn(),
      send,
      maxOutstandingDemand: 10
    }).handleDemand(credit(1))

    await tick()

    expect(send).toHaveBeenCalledWith<[StreamEndMessage]>({ kind: 'end', handleId: HANDLE })
  })

  it('maps an abrupt end to a coded end message and calls onStreamFailed, matching port-pump.ts\'s own shape', async () => {
    const send = vi.fn()
    const onStreamFailed = vi.fn()
    const error = { name: 'OrivonError', message: 'boom', code: 'internal' }
    createAcceptPump({
      handleId: HANDLE,
      connections: erroringConnectionStream([], error),
      onAccepted: vi.fn(),
      send,
      maxOutstandingDemand: 10,
      onStreamFailed
    }).handleDemand(credit(1))

    await tick()

    expect(send).toHaveBeenCalledWith<[StreamEndMessage]>({ kind: 'end', handleId: HANDLE, code: 'internal' })
    expect(onStreamFailed).toHaveBeenCalledWith('internal', error)
  })

  it('maps a raw (non-OrivonError) failure to \'internal\', never leaving the app with no terminal message', async () => {
    const send = vi.fn()
    createAcceptPump({
      handleId: HANDLE,
      connections: erroringConnectionStream([], new Error('not OrivonError-shaped')),
      onAccepted: vi.fn(),
      send,
      maxOutstandingDemand: 10
    }).handleDemand(credit(1))

    await tick()

    expect(send).toHaveBeenCalledWith<[StreamEndMessage]>({ kind: 'end', handleId: HANDLE, code: 'internal' })
  })

  it('stop() sends a terminal end message immediately and releases the reader, without waiting on demand', async () => {
    const send = vi.fn()
    const pump = createAcceptPump({
      handleId: HANDLE,
      // Never closes -- there is always more the pump COULD read, the same
      // shape transport/relay/tests/socket.test.ts uses for its own stop() test.
      connections: new ReadableStream<FailableTcpSocket>({ start (c) { c.enqueue(fakeAccepted('a')) } }),
      onAccepted: vi.fn(),
      send,
      maxOutstandingDemand: 10
    })

    pump.stop('revoked')
    await tick()

    expect(send).toHaveBeenCalledWith<[StreamEndMessage]>({ kind: 'end', handleId: HANDLE, code: 'revoked' })
  })

  it('stop() is idempotent -- exactly one end message however many times it is called', async () => {
    const send = vi.fn()
    const pump = createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([]),
      onAccepted: vi.fn(),
      send,
      maxOutstandingDemand: 10
    })

    pump.stop('revoked')
    pump.stop('revoked')
    pump.stop('revoked')
    await tick()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a demand message arriving after stop() accepts nothing further', async () => {
    const onAccepted = vi.fn()
    const pump = createAcceptPump({
      handleId: HANDLE,
      connections: connectionStream([fakeAccepted('a')]),
      onAccepted,
      send: vi.fn(),
      maxOutstandingDemand: 10
    })

    pump.stop()
    pump.handleDemand(credit(1))
    await tick()

    expect(onAccepted).not.toHaveBeenCalled()
  })
})
