// The unlink hook: HandleTable telling a resource's consumer that a handle has
// left the tables, at the moment it leaves them rather than when its teardown
// finishes. See src/broker/README.md's "Design notes" for why this exists at
// all (open-questions.md A84) -- these tests only pin the behaviour.

import { describe, expect, it, vi } from 'vitest'
import type { OrivonErrorCode } from '../contracts/index.js'
import type { CloseReason } from './handles/handle-contracts.js'
import { HandleTable } from './handles/handles.js'
import { APP, TCP_GRANT, never, table } from './handles.test-helpers.js'

/** Acquires one grant-authorised socket whose destroy never settles -- A84's peer that never drains. */
function stuckSocket (): { handles: ReturnType<typeof table>, id: string, destroyed: string[] } {
  const handles = table()
  handles.grantIssued(APP, TCP_GRANT)
  const destroyed: string[] = []
  const entry = handles.acquire({
    origin: APP,
    kind: 'tcpSocket',
    authorisedBy: { by: 'grant', grantId: TCP_GRANT },
    destroy: async (reason) => { destroyed.push(reason); return await never<void>() }
  })
  return { handles, id: entry.id, destroyed }
}

describe('HandleTable.onUnlink', () => {
  it('fires when the app closes a handle, even though destroy never settles', () => {
    const { handles, id } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    handles.onUnlink(APP, id, listener)

    void handles.release(APP, id)

    // Synchronously, in the same turn: this is the whole point. Before this
    // hook the only teardown trigger was `closed`, which a non-draining peer
    // holds open forever (A84).
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fires with the reason AND no code for an app-initiated close', () => {
    const { handles, id } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    handles.onUnlink(APP, id, listener)

    void handles.release(APP, id)

    expect(listener).toHaveBeenCalledWith('closed', undefined)
  })

  it('fires with the reason and the real code when the grant is withdrawn', async () => {
    const { handles, id } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    handles.onUnlink(APP, id, listener)

    await handles.revoke(APP, TCP_GRANT)

    expect(listener).toHaveBeenCalledWith('revoked', 'revoked')
  })

  it('fires before the destroy callback is awaited, not after', () => {
    const { handles, id, destroyed } = stuckSocket()
    const order: string[] = []
    handles.onUnlink(APP, id, () => { order.push('unlink') })

    void handles.release(APP, id)

    expect(order).toEqual(['unlink'])
    expect(destroyed).toEqual(['closed'])
  })

  it('fires exactly once, however many times the handle is closed', async () => {
    const { handles, id } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    handles.onUnlink(APP, id, listener)

    // NOT awaited, and that is the point: closeTree awaits every destroy, and
    // this fixture's never settles. In production the same call does return,
    // because destroySocket's own drain deadline settles it one layer below
    // (./socket-drain.test.ts) -- a stall this table cannot see.
    void handles.release(APP, id)
    void handles.release(APP, id)
    await handles.revoke(APP, TCP_GRANT)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a session teardown from a revoke by REASON, since both carry code revoked', () => {
    // The relay branches on reason precisely because the code cannot tell
    // these apart, and one flushes while the other resets. Not awaited, for
    // the same reason as the case above: this fixture's destroy never settles.
    const { handles, id } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    handles.onUnlink(APP, id, listener)

    void handles.dropOrigin(APP)

    expect(listener).toHaveBeenCalledWith('sessionEnded', 'revoked')
  })

  it('reports a throwing listener through onFault and still tears the handle down', () => {
    const faults: unknown[] = []
    const handles = new HandleTable({ onFault: (fault) => { faults.push(fault) } })
    handles.grantIssued(APP, TCP_GRANT)
    const destroyed: string[] = []
    const entry = handles.acquire({
      origin: APP,
      kind: 'tcpSocket',
      authorisedBy: { by: 'grant', grantId: TCP_GRANT },
      destroy: async (reason) => { destroyed.push(reason) }
    })
    handles.onUnlink(APP, entry.id, () => { throw new Error('listener blew up') })

    expect(() => { void handles.release(APP, entry.id) }).not.toThrow()
    expect(faults).toHaveLength(1)
    expect(destroyed).toEqual(['closed'])
  })

  it('is a silent no-op for a handle this origin does not hold', () => {
    const { handles } = stuckSocket()
    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()

    expect(() => { handles.onUnlink(APP, 'never-existed', listener) }).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('is a silent no-op for a handle that has already been unlinked', () => {
    const { handles, id } = stuckSocket()
    void handles.release(APP, id)

    const listener = vi.fn<(reason: CloseReason, code?: OrivonErrorCode) => void>()
    // Registering late must not invent a terminal code it cannot know. The
    // socket's own `closed` promise is the backstop for this window and
    // carries the real reason -- see socket-relay.ts's subscription to it.
    expect(() => { handles.onUnlink(APP, id, listener) }).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
