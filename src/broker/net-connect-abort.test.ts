// FailableTcpSocket.abort -- sibling of ./net-connect-fail.test.ts, covering
// the OTHER way a handle stops being alive: the app itself choosing to
// discard a still-live one, rather than a peer or the resource layer
// reporting that it died on its own (handle-contracts.md's close table,
// `writable.abort(e)`).

import { describe, expect, it, vi } from 'vitest'
import { rejection } from './handles.test-helpers.js'
import { brokerWithConnectGrant, okSocket } from './index.test-helpers.js'

describe('FailableTcpSocket.abort lets a caller report the app discarding a still-live handle', () => {
  it('rejects closed with reset, per handle-contracts.md\'s close table', async () => {
    const broker = await brokerWithConnectGrant()
    const socket = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    socket.abort()

    const error = await rejection(socket.closed)
    expect(error.code).toBe('reset')
  })

  it('tells the destroy callback to reset the wire, not merely release the fd', async () => {
    const destroy = vi.fn()
    const broker = await brokerWithConnectGrant({ dial: async () => okSocket({ destroy }) })
    const socket = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    socket.abort()

    // 'aborted', not fail()'s 'failed' -- node-adapters.ts routes it to the
    // same active reset as 'revoked', not to a silent fd release.
    expect(destroy).toHaveBeenCalledWith('aborted')
  })

  it('releases the handle -- a second connect from the same origin does not collide with it', async () => {
    const broker = await brokerWithConnectGrant()
    const first = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    first.abort()
    await rejection(first.closed)
    const second = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    expect(second.id).not.toBe(first.id)
    await second.close()
  })
})
