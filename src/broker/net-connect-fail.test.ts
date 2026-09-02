// FailableTcpSocket.fail -- split out of index.test.ts under
// code-guidelines.md's 800-line test limit, following handles.test-helpers.ts's
// established split pattern (a coherent concern gets its own sibling file).
//
// ./handle-contracts.ts's entry point for "this resource died underneath
// us" -- otherwise a peer RST is reported as a clean successful close, which
// is the COMMON way a socket ends (handle-contracts.md). Only ./ipc.ts's
// port pump calls this in production, the moment it detects the underlying
// OS socket has errored; nothing here is reachable from orivon.net directly.

import { describe, expect, it } from 'vitest'
import { rejection } from './handles.test-helpers.js'
import { brokerWithConnectGrant } from './index.test-helpers.js'

describe('FailableTcpSocket.fail lets a caller report a resource that died on its own', () => {
  it('rejects closed with the given code and platformCode, instead of resolving it', async () => {
    const broker = await brokerWithConnectGrant()
    const socket = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    socket.fail('reset', 'ECONNRESET')

    const error = await rejection(socket.closed)
    expect(error.code).toBe('reset')
    expect(error.platformCode).toBe('ECONNRESET')
  })

  // Otherwise LIMITS.concurrentSockets keeps counting it, and enough of
  // these permanently exhaust an origin's socket budget.
  it('releases the handle -- a second connect from the same origin does not collide with it', async () => {
    const broker = await brokerWithConnectGrant()
    const first = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    first.fail('reset')
    await rejection(first.closed)
    const second = await broker.net.connect('https://app.example', { host: '93.184.216.34', port: 443 })

    expect(second.id).not.toBe(first.id)
    await second.close()
  })
})
