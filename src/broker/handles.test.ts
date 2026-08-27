import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../contracts/index.js'
import type { OrivonError } from '../contracts/index.js'
import { HandleTable, toWire } from './handles.js'
import type { CloseReason } from './handles.js'

// The handle table is the enforcement point for four of the failures in
// security-model.md that are SILENT when they happen:
//
//   T11c  a handle id from one origin used by another. Nothing throws in a
//         naive implementation -- the operation simply succeeds against
//         somebody else's socket.
//   T11   an origin holding unbounded sockets, files or in-flight calls.
//   T11b  the broker's UI thread blocked by a queue one origin filled.
//   The revoke button not revoking. The user clicks it, the UI says the
//         capability is gone, and a derived socket keeps sending.
//
// None of these is visible from using the product, which is why they are
// tested here at a level of detail the rest of the broker will not need.
//
// EVERY test below was checked against a deliberately-broken implementation
// (see the PR body): the ownership check removed, the cascade not walking
// derived handles, the in-flight cap queueing instead of rejecting, and
// userSelected handles swept up by the cascade. A suite that passes proves
// nothing until it has been watched to fail.

const APP = 'https://app.example'
const OTHER = 'https://other.example'
const TCP_GRANT = 'grant-tcp-connect'
const FS_GRANT = 'grant-fs'

function table (): HandleTable {
  return new HandleTable()
}

/** A destroy hook that records the reason it was called with. */
function spyDestroy (): ReturnType<typeof vi.fn<(reason: CloseReason) => void>> {
  return vi.fn<(reason: CloseReason) => void>()
}

function noop (): void {}

/** Runs `fn`, returning the OrivonError it threw. Fails if it did not throw. */
function thrown (fn: () => unknown): OrivonError {
  try {
    fn()
  } catch (error) {
    return error as OrivonError
  }
  throw new Error('expected the call to throw, and it returned instead')
}

/** Awaits `promise`, returning the OrivonError it rejected with. */
async function rejection (promise: Promise<unknown>): Promise<OrivonError> {
  try {
    await promise
  } catch (error) {
    return error as OrivonError
  }
  throw new Error('expected the promise to reject, and it resolved instead')
}

/** A promise that never settles -- an operation still in flight. */
function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

const PENDING = Symbol('pending')

/**
 * The outcome of `promise` as of the next macrotask, WITHOUT waiting for it.
 *
 * This is what separates "rejects immediately" from "queues and rejects
 * later": an implementation that waits for a free slot leaves the promise
 * pending here, and the assertion fails in milliseconds instead of hanging
 * until the test times out.
 */
async function outcomeNow<T> (promise: Promise<T>): Promise<
  { readonly state: 'pending' } | { readonly state: 'rejected', readonly error: OrivonError } | { readonly state: 'resolved', readonly value: T }
> {
  const tick = new Promise<typeof PENDING>((resolve) => { setTimeout(() => { resolve(PENDING) }, 0) })
  const settled = promise.then(
    (value) => ({ state: 'resolved' as const, value }),
    (error: OrivonError) => ({ state: 'rejected' as const, error })
  )
  const outcome = await Promise.race([settled, tick])
  return outcome === PENDING ? { state: 'pending' } : outcome
}

function acquireSocket (t: HandleTable, origin = APP, grantId = TCP_GRANT): ReturnType<HandleTable['acquire']> {
  return t.acquire({ origin, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId }, destroy: noop })
}

describe('ownership is re-checked on every operation (T11c)', () => {
  it('rejects a handle id issued to one origin when another origin presents it', () => {
    const t = table()
    const handle = acquireSocket(t)

    // REJECTED, not ignored. An implementation that returns undefined or
    // silently no-ops here hands the attacker a probe that costs nothing.
    expect(thrown(() => t.lookup(OTHER, handle.id)).code).toBe('denied')
  })

  it('accepts the same id from the origin it was issued to', () => {
    const t = table()
    const handle = acquireSocket(t)

    expect(t.lookup(APP, handle.id).id).toBe(handle.id)
  })

  it('does not let another origin close a handle it does not own', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    // close() is idempotent without qualification (SSCommon shape), so this
    // does not throw -- but it must not CLOSE anything either, which is the
    // half that carries the security weight.
    await expect(t.release(OTHER, handle.id)).resolves.toBeUndefined()
    expect(destroy).not.toHaveBeenCalled()
    expect(t.lookup(APP, handle.id).id).toBe(handle.id)
  })

  it('does not run work for another origin', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const work = vi.fn(async () => 'done')

    const error = await rejection(t.run(OTHER, { on: 'handle', handleId: handle.id }, work))

    expect(error.code).toBe('denied')
    expect(work).not.toHaveBeenCalled()
  })

  it('does not let another origin revoke a grant it does not hold', async () => {
    const t = table()
    const destroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await t.revoke(OTHER, TCP_GRANT)

    expect(destroy).not.toHaveBeenCalled()
  })

  it('answers an unknown id and another origin id identically', () => {
    const t = table()
    const handle = acquireSocket(t)

    const foreign = thrown(() => t.lookup(OTHER, handle.id))
    const unknown = thrown(() => t.lookup(OTHER, 'ffffffffffffffffffffffffffffffff'))

    // If these differed, an app could ask "does this id exist somewhere else?"
    // and enumerate the id space of every other origin one probe at a time.
    expect(foreign.code).toBe(unknown.code)
    expect(foreign.message).toBe(unknown.message)
  })

  it('re-checks on every operation, not only the first', async () => {
    const t = table()
    const handle = acquireSocket(t)

    await expect(t.run(APP, { on: 'handle', handleId: handle.id }, async () => 'first')).resolves.toBe('first')
    await t.revoke(APP, TCP_GRANT)

    // Capability is checked once at acquisition (capability-api.md design rule
    // 3), but OWNERSHIP is checked every time. A table that cached the first
    // answer would keep serving a revoked handle.
    expect((await rejection(t.run(APP, { on: 'handle', handleId: handle.id }, async () => 'second'))).code).toBe('closed')
  })

  it('reports an already-closed handle as closed rather than denied to its owner', async () => {
    const t = table()
    const handle = acquireSocket(t)
    await t.release(APP, handle.id)

    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('closed')
    // ... but to anyone else it stays indistinguishable from an id that never
    // existed.
    expect(thrown(() => t.lookup(OTHER, handle.id)).code).toBe('denied')
  })
})

describe('every handle records the grant that authorised it', () => {
  it('captures the grant at acquisition', () => {
    const t = table()
    const handle = acquireSocket(t)

    expect(handle.authorisedBy).toEqual({ by: 'grant', grantId: TCP_GRANT })
  })

  it('gives a derived handle its parent grant, which the caller cannot override', () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })

    const accepted = t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: noop })

    // acquireDerived takes no authorisation argument at all -- the grant comes
    // from the parent record. "Derived handles inherit the parent's grant" is
    // then structurally true rather than a convention a caller must remember.
    expect(accepted.authorisedBy).toEqual({ by: 'grant', grantId: 'grant-tcp-listen' })
    expect(accepted.parentId).toBe(server.id)
  })

  it('refuses to derive from a handle another origin owns', () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })

    const error = thrown(() => t.acquireDerived({ origin: OTHER, kind: 'tcpSocket', parentId: server.id, destroy: noop }))

    expect(error.code).toBe('denied')
  })
})

describe('the revocation cascade', () => {
  it('closes every handle the revoked grant authorised', async () => {
    const t = table()
    const first = spyDestroy()
    const second = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: first })
    t.acquire({ origin: APP, kind: 'udpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: second })

    await t.revoke(APP, TCP_GRANT)

    expect(first).toHaveBeenCalledWith('revoked')
    expect(second).toHaveBeenCalledWith('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })

  it('closes sockets a revoked server produced', async () => {
    const t = table()
    const serverDestroy = spyDestroy()
    const acceptedDestroy = spyDestroy()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: serverDestroy })
    const accepted = t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: acceptedDestroy })

    await t.revoke(APP, 'grant-tcp-listen')

    expect(serverDestroy).toHaveBeenCalledWith('revoked')
    expect(acceptedDestroy).toHaveBeenCalledWith('revoked')
    expect(thrown(() => t.lookup(APP, accepted.id)).code).toBe('closed')
  })

  it('closes every socket a server produced when the server itself is closed', async () => {
    const t = table()
    const destroys = [spyDestroy(), spyDestroy(), spyDestroy()]
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    for (const destroy of destroys) {
      t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy })
    }

    await t.release(APP, server.id)

    for (const destroy of destroys) {
      expect(destroy).toHaveBeenCalledWith('closed')
    }
    expect(t.counts(APP).handles).toBe(0)
  })

  it('reaches handles derived from derived handles', async () => {
    const t = table()
    const grandchild = spyDestroy()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    const child = t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: noop })
    t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: child.id, destroy: grandchild })

    await t.revoke(APP, 'grant-tcp-listen')

    expect(grandchild).toHaveBeenCalledWith('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })

  it('leaves handles under a different grant open', async () => {
    const t = table()
    const untouched = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })
    const file = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: untouched })

    await t.revoke(APP, TCP_GRANT)

    expect(untouched).not.toHaveBeenCalled()
    expect(t.lookup(APP, file.id).id).toBe(file.id)
  })

  it('leaves another origin holding the same grant id untouched', async () => {
    const t = table()
    const mine = spyDestroy()
    const theirs = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: mine })
    t.acquire({ origin: OTHER, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: theirs })

    await t.revoke(APP, TCP_GRANT)

    expect(mine).toHaveBeenCalledWith('revoked')
    expect(theirs).not.toHaveBeenCalled()
  })

  it('does not destroy a handle twice when it is reached by two paths', async () => {
    const t = table()
    const destroy = spyDestroy()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })
    // Reachable both as a member of TCP_GRANT's set and as the server's child.
    t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy })

    await t.revoke(APP, TCP_GRANT)

    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

describe('revocation is immediate and abrupt, never graceful', () => {
  it('rejects every pending operation with revoked', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.revoke(APP, TCP_GRANT)

    expect((await rejection(pending)).code).toBe('revoked')
  })

  it('aborts the signal the operation was given', async () => {
    const t = table()
    const handle = acquireSocket(t)
    let signal: AbortSignal | null = null
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, async (s) => {
      signal = s
      return await never<string>()
    })
    await Promise.resolve()

    await t.revoke(APP, TCP_GRANT)
    await rejection(pending)

    expect(signal).not.toBeNull()
    expect((signal as unknown as AbortSignal).aborted).toBe(true)
  })

  it('does not let work that finishes later resolve the app-facing promise', async () => {
    const t = table()
    const handle = acquireSocket(t)
    let finish: ((value: string) => void) | null = null
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, async () => await new Promise<string>((resolve) => { finish = resolve }))
    await Promise.resolve()

    await t.revoke(APP, TCP_GRANT)
    // The hostile case the specification names: completion time is entirely
    // under the app's control, so the revoke must not be waiting for it.
    ;(finish as unknown as (value: string) => void)('too late')

    expect((await rejection(pending)).code).toBe('revoked')
  })

  it('rejects the closed promise with revoked', async () => {
    const t = table()
    const handle = acquireSocket(t)

    await t.revoke(APP, TCP_GRANT)

    expect((await rejection(handle.closed)).code).toBe('revoked')
  })

  it('tells the app before a slow teardown finishes', async () => {
    const t = table()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: never })
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    // Deliberately NOT awaited: this destroy never completes, so a cascade
    // that waited for it would leave the app connected indefinitely.
    void t.revoke(APP, TCP_GRANT)

    expect((await rejection(pending)).code).toBe('revoked')
    expect((await rejection(handle.closed)).code).toBe('revoked')
  })

  it('rejects an acquisition that is still in flight under the revoked grant', async () => {
    const t = table()
    // A connect that has passed the policy check but has no handle yet.
    const connecting = t.run(APP, { on: 'grant', grantId: TCP_GRANT }, never)

    await t.revoke(APP, TCP_GRANT)

    expect((await rejection(connecting)).code).toBe('revoked')
  })

  it('rejects pending operations on derived handles too', async () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    const accepted = t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: noop })
    const pending = t.run(APP, { on: 'handle', handleId: accepted.id }, never)

    await t.revoke(APP, 'grant-tcp-listen')

    expect((await rejection(pending)).code).toBe('revoked')
  })

  it('rejects a pending operation with closed when the app closes the handle itself', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.release(APP, handle.id)

    expect((await rejection(pending)).code).toBe('closed')
    await expect(handle.closed).resolves.toBeUndefined()
  })
})

describe('revocation and release are idempotent', () => {
  it('revokes twice without destroying twice', async () => {
    const t = table()
    const destroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await t.revoke(APP, TCP_GRANT)
    await t.revoke(APP, TCP_GRANT)

    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('is safe against an origin holding zero handles', async () => {
    const t = table()
    acquireSocket(t)

    await expect(t.revoke(APP, 'grant-never-used')).resolves.toBeUndefined()
  })

  it('is safe against an origin the table has never seen', async () => {
    const t = table()

    await expect(t.revoke('https://stranger.example', TCP_GRANT)).resolves.toBeUndefined()
  })

  it('releases twice without destroying twice', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await t.release(APP, handle.id)
    await expect(t.release(APP, handle.id)).resolves.toBeUndefined()

    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('resolves the closed promise once, on the first close', async () => {
    const t = table()
    const handle = acquireSocket(t)

    await t.release(APP, handle.id)
    await t.release(APP, handle.id)

    await expect(handle.closed).resolves.toBeUndefined()
  })
})

describe('per-origin limits (T11, T11b)', () => {
  it('allows exactly LIMITS.concurrentSockets sockets and refuses the next', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentSockets; i += 1) {
      acquireSocket(t)
    }

    expect(t.counts(APP).sockets).toBe(LIMITS.concurrentSockets)
    expect(thrown(() => acquireSocket(t)).code).toBe('limit')
  })

  it('shares one socket budget between tcp, udp, servers and accepted connections', () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    t.acquire({ origin: APP, kind: 'udpSocket', authorisedBy: { by: 'grant', grantId: 'grant-udp-bind' }, destroy: noop })
    t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: noop })

    // The listening socket is counted too -- see the DEVIATION note in
    // handles.ts. Without it an origin could hold unbounded listeners.
    expect(t.counts(APP).sockets).toBe(3)
  })

  it('counts sockets per origin, not globally', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentSockets; i += 1) {
      acquireSocket(t)
    }

    // One origin exhausting its budget must not deny every other tab.
    expect(() => acquireSocket(t, OTHER)).not.toThrow()
  })

  it('allows exactly LIMITS.concurrentFileHandles files and refuses the next', () => {
    const t = table()
    const open = (): unknown => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: noop })
    for (let i = 0; i < LIMITS.concurrentFileHandles; i += 1) {
      open()
    }

    expect(thrown(open).code).toBe('limit')
  })

  it('frees a slot when a handle closes', async () => {
    const t = table()
    const handles: string[] = []
    for (let i = 0; i < LIMITS.concurrentSockets; i += 1) {
      handles.push(acquireSocket(t).id)
    }
    const first = handles[0]
    expect(first).toBeDefined()

    await t.release(APP, first as string)

    expect(() => acquireSocket(t)).not.toThrow()
  })

  it('rejects the operation past the in-flight cap immediately, without queueing', async () => {
    const t = table()
    const handle = acquireSocket(t)
    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      void t.run(APP, { on: 'handle', handleId: handle.id }, never).catch(() => {})
    }

    const outcome = await outcomeNow(t.run(APP, { on: 'handle', handleId: handle.id }, never))

    // An unbounded queue on the broker's UI thread is precisely how one
    // misbehaving origin freezes every tab (T11b). "pending" here means the
    // implementation queued.
    expect(outcome.state).toBe('rejected')
    expect(outcome.state === 'rejected' ? outcome.error.code : null).toBe('limit')
  })

  it('never runs the work of an operation past the in-flight cap', async () => {
    const t = table()
    const handle = acquireSocket(t)
    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      void t.run(APP, { on: 'handle', handleId: handle.id }, never).catch(() => {})
    }
    const work = vi.fn(async () => 'done')

    await rejection(t.run(APP, { on: 'handle', handleId: handle.id }, work))

    expect(work).not.toHaveBeenCalled()
  })

  it('frees an in-flight slot when the operation settles', async () => {
    const t = table()
    const handle = acquireSocket(t)
    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      await t.run(APP, { on: 'handle', handleId: handle.id }, async () => 'done')
    }

    expect(t.counts(APP).inFlight).toBe(0)
    await expect(t.run(APP, { on: 'handle', handleId: handle.id }, async () => 'again')).resolves.toBe('again')
  })

  it('frees an in-flight slot when the operation rejects', async () => {
    const t = table()
    const handle = acquireSocket(t)

    await rejection(t.run(APP, { on: 'handle', handleId: handle.id }, async () => { throw new Error('boom') }))

    expect(t.counts(APP).inFlight).toBe(0)
  })

  it('bounds the kinds the specification caps nowhere', () => {
    const t = table()
    const open = (): unknown => t.acquire({ origin: APP, kind: 'identity', authorisedBy: { by: 'grant', grantId: 'grant-id' }, destroy: noop })
    for (let i = 0; i < LIMITS.concurrentFileHandles; i += 1) {
      open()
    }

    // SSLimits caps sockets and files and says nothing about IdentityHandles.
    // Uncapped rows are T11 whatever the row holds, so the table applies a
    // backstop derived from the budgets it already has. Flagged in handles.ts.
    expect(thrown(open).code).toBe('limit')
  })

  it('destroys the resource an acquisition it refused was handed', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentSockets; i += 1) {
      acquireSocket(t)
    }
    const destroy = spyDestroy()

    thrown(() => t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy }))

    // The caller already has a connected socket by the time it registers it.
    // If a refused acquisition did not release it, hitting the cap in a loop
    // would leak an fd per attempt while the table still reported 512.
    // 'failed', not 'closed': the handle never existed, so there is no wire
    // effect owed to anyone -- only the descriptor needs freeing.
    expect(destroy).toHaveBeenCalledWith('failed')
  })
})

describe('the fs.userSelected exception', () => {
  it('keeps a picker-authorised file open across an fs revocation', async () => {
    const t = table()
    const granted = spyDestroy()
    const picked = spyDestroy()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: granted })
    const userSelected = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: picked })

    await t.revoke(APP, FS_GRANT)

    // The user's one-time choice at the OS picker IS the authorisation. It is
    // not the standing fs grant, so withdrawing that grant cannot withdraw it.
    expect(granted).toHaveBeenCalledWith('revoked')
    expect(picked).not.toHaveBeenCalled()
    expect(t.lookup(APP, userSelected.id).id).toBe(userSelected.id)
  })

  it('still counts a picker-authorised file against the file limit', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentFileHandles; i += 1) {
      t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop })
    }

    // The exception is to the revocation cascade only. An open fd is an open
    // fd however the user authorised it.
    expect(thrown(() => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop })).code).toBe('limit')
  })

  it('does not survive the session', async () => {
    const t = table()
    const picked = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: picked })

    await t.dropOrigin(APP)

    // Session-scoped, not a standing grant of its own: it must not come back
    // after a restart, so the session teardown has to take it.
    expect(picked).toHaveBeenCalledWith('sessionEnded')
    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('denied')
  })

  it('closes grant-authorised handles and pending operations on session teardown', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.dropOrigin(APP)

    expect(destroy).toHaveBeenCalledWith('sessionEnded')
    expect((await rejection(pending)).code).toBe('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })

  it('leaves other origins alone on session teardown', async () => {
    const t = table()
    const theirs = spyDestroy()
    t.acquire({ origin: OTHER, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: theirs })

    await t.dropOrigin(APP)

    expect(theirs).not.toHaveBeenCalled()
  })
})

describe('handle ids are not forgeable or guessable across origins', () => {
  it('never repeats an id, within an origin or across origins', () => {
    const t = table()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      ids.add(acquireSocket(t, APP).id)
      ids.add(acquireSocket(t, OTHER).id)
    }

    expect(ids.size).toBe(400)
  })

  it('carries no origin, kind or sequence information', () => {
    const t = table()
    const first = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })
    const second = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: noop })

    // 128 bits of CSPRNG output, rendered as hex. A counter, a timestamp or
    // anything derived from the origin would let one app name another app's
    // handles -- which the ownership check would still refuse, but defence in
    // depth is the point.
    expect(first.id).toMatch(/^[0-9a-f]{32}$/)
    expect(second.id).toMatch(/^[0-9a-f]{32}$/)
    expect(first.id.slice(0, 16)).not.toBe(second.id.slice(0, 16))
  })

  it('does not share a prefix across a large sample', () => {
    const t = table()
    const prefixes = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      prefixes.add(acquireSocket(t).id.slice(0, 16))
    }

    // A monotonic or time-seeded generator collapses this set.
    expect(prefixes.size).toBe(200)
  })
})

describe('the origin key', () => {
  it('treats every spelling of one origin as one table', () => {
    const t = table()
    const handle = t.acquire({ origin: 'https://app.example:443/deep/path?q=1', kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })

    // origin.ts is the single definition of the isolation key. If this module
    // keyed on the raw string instead, one app reached by two spellings would
    // get two tables -- two socket budgets, and a revoke that only reached one
    // of them.
    expect(handle.origin).toBe(APP)
    expect(t.lookup(APP, handle.id).id).toBe(handle.id)
    expect(t.counts('https://app.example/other').sockets).toBe(1)
  })

  it('cannot have its limits evaded by varying the spelling', () => {
    const t = table()
    for (let i = 0; i < LIMITS.concurrentSockets; i += 1) {
      acquireSocket(t)
    }

    expect(thrown(() => acquireSocket(t, 'https://app.example:443')).code).toBe('limit')
    expect(thrown(() => acquireSocket(t, 'https://APP.example/x')).code).toBe('limit')
  })

  it('refuses a string that is not an origin that may key storage', () => {
    const t = table()

    for (const notAnOrigin of ['file:///etc/passwd', 'data:text/html,x', 'blob:https://app.example/u', 'about:blank', 'app.example', '']) {
      // A broker fault, not an app-visible denial: the app never supplies its
      // own origin, the broker derives it from the sender frame.
      expect(thrown(() => t.acquire({ origin: notAnOrigin, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })).code).toBe('internal')
    }
  })
})

describe('broker faults during teardown', () => {
  it('reports a destroy that throws without leaving the handle live', async () => {
    const faults: unknown[] = []
    const t = new HandleTable({ onFault: (fault) => { faults.push(fault.error) } })
    const handle = t.acquire({
      origin: APP,
      kind: 'tcpSocket',
      authorisedBy: { by: 'grant', grantId: TCP_GRANT },
      destroy: () => { throw new Error('the socket was already gone') }
    })

    await expect(t.release(APP, handle.id)).resolves.toBeUndefined()

    expect(faults).toHaveLength(1)
    expect(t.counts(APP).handles).toBe(0)
    // 'internal' is the code the enum reserves for a broker fault. It reaches
    // the app through `closed` rather than through close(), which stays
    // idempotent and non-throwing.
    expect((await rejection(handle.closed)).code).toBe('internal')
  })

  it('completes the cascade even when one destroy throws', async () => {
    const t = table()
    const second = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: () => { throw new Error('boom') } })
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: second })

    await t.revoke(APP, TCP_GRANT)

    expect(second).toHaveBeenCalledWith('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Added by the review pass (2026-08-27). Every block below was written from
// handle-contracts.md rather than from handles.ts, because the first suite's
// blind spot was that it tested each method in isolation and never tested the
// ORDERING BETWEEN methods -- which is where all six review findings lived.
// ---------------------------------------------------------------------------

describe('a grant stays revoked (the cascade is not a one-shot sweep)', () => {
  it('refuses an acquisition that lands after the revoke', () => {
    const t = table()
    void t.revoke(APP, TCP_GRANT)

    // The connect passed the policy check BEFORE the revoke and its socket
    // materialised after. Without a tombstone this registers a live handle
    // under a withdrawn grant, and the UI fires exactly one revoke, so nothing
    // ever sweeps again.
    expect(thrown(() => acquireSocket(t)).code).toBe('revoked')
  })

  it('releases the resource of an acquisition it refused as revoked', () => {
    const t = table()
    void t.revoke(APP, TCP_GRANT)
    const destroy = spyDestroy()

    thrown(() => t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy }))

    expect(destroy).toHaveBeenCalledWith('failed')
  })

  it('refuses a derived acquisition once the revoke has taken its parent', () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    void t.revoke(APP, 'grant-tcp-listen')

    // A connection accepted mid-flight, registering after the cascade swept.
    // The answer is 'closed' rather than 'revoked' because the cascade reached
    // the parent first and that is the honest reason -- the tombstone check in
    // acquireDerived is the belt to this braces, for the case where a parent
    // somehow outlives its grant.
    expect(thrown(() => t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: noop })).code).toBe('closed')
  })

  it('refuses an operation scoped to a revoked grant', async () => {
    const t = table()
    void t.revoke(APP, TCP_GRANT)

    expect((await rejection(t.run(APP, { on: 'grant', grantId: TCP_GRANT }, never))).code).toBe('revoked')
  })

  it('leaves no live row behind when destroy re-enters acquire', async () => {
    const t = table()
    let orphanReleased: CloseReason | null = null
    t.acquire({
      origin: APP,
      kind: 'tcpSocket',
      authorisedBy: { by: 'grant', grantId: TCP_GRANT },
      // destroy runs synchronously inside the cascade, before it finishes.
      destroy: () => {
        try {
          t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: (r) => { orphanReleased = r } })
        } catch { /* refused by the tombstone, which is the point */ }
      }
    })

    await t.revoke(APP, TCP_GRANT)

    // What must NOT happen is a live row in no grant's set, which no later
    // revoke could find. The tombstone refuses it, and the refusal still
    // releases the descriptor the caller had already opened.
    expect(t.counts(APP).handles).toBe(0)
    expect(orphanReleased).toBe('failed')
  })

  it('does not orphan a row when the grant is re-issued mid-cascade', async () => {
    const t = table()
    let survivor: string | null = null
    t.acquire({
      origin: APP,
      kind: 'tcpSocket',
      authorisedBy: { by: 'grant', grantId: TCP_GRANT },
      destroy: () => {
        // The tombstone normally refuses this. Clearing it first is the one
        // legitimate sequence that gets a live row into the set the cascade is
        // still holding -- so it is what pins the guard on the bucket delete.
        t.grantIssued(APP, TCP_GRANT)
        survivor = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop }).id
      }
    })

    await t.revoke(APP, TCP_GRANT)
    expect(survivor).not.toBeNull()

    // Deleting the grant's bucket wholesale would drop this row into no set at
    // all, where not even a later revoke of the same grant could reach it.
    await t.revoke(APP, TCP_GRANT)
    expect(t.counts(APP).handles).toBe(0)
  })

  it('lets the user grant the capability again', () => {
    const t = table()
    void t.revoke(APP, TCP_GRANT)
    expect(thrown(() => acquireSocket(t)).code).toBe('revoked')

    // The broker calls this when the user grants the capability again. Without
    // it, a grant ledger that mints a STABLE id per (origin, capability,
    // patterns) could never re-grant anything the user had once withdrawn.
    t.grantIssued(APP, TCP_GRANT)

    expect(() => acquireSocket(t)).not.toThrow()
  })

  it('never blocks a picker-authorised handle, whatever was revoked', () => {
    const t = table()
    void t.revoke(APP, FS_GRANT)

    // userSelected is authorised by the OS picker, not by any grant, so no
    // tombstone can apply to it.
    expect(() => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop })).not.toThrow()
  })

  it('bounds how many revoked grant ids it remembers', () => {
    const t = table()
    for (let i = 0; i < 5000; i += 1) {
      void t.revoke(APP, `grant-${String(i)}`)
    }

    // An unbounded tombstone set is the memory leak #remember exists to avoid.
    expect(t.counts(APP).revokedGrants).toBeLessThanOrEqual(LIMITS.concurrentSockets + LIMITS.concurrentFileHandles)
  })
})

describe('close() is idempotent without qualification (SSCommon shape)', () => {
  it('stays a no-op past the recently-closed memory', async () => {
    const t = table()
    const handle = acquireSocket(t)
    await t.release(APP, handle.id)

    // Churn past CLOSED_ID_MEMORY. The torrent app does this in seconds, and
    // the shim must present Node's socket.destroy(), which never throws.
    for (let i = 0; i < LIMITS.concurrentSockets + LIMITS.concurrentFileHandles + 32; i += 1) {
      const churn = acquireSocket(t)
      await t.release(APP, churn.id)
    }

    await expect(t.release(APP, handle.id)).resolves.toBeUndefined()
  })

  it('still names a handle it closed recently enough to remember', async () => {
    const t = table()
    const handle = acquireSocket(t)
    await t.release(APP, handle.id)
    for (let i = 0; i < 100; i += 1) {
      const churn = acquireSocket(t)
      await t.release(APP, churn.id)
    }

    // Now that idempotence no longer depends on it, CLOSED_ID_MEMORY's only
    // remaining job is diagnostic: telling an origin 'closed' rather than
    // 'denied' about its own handle. Degrading to 'denied' past the bound is
    // acceptable, but the bound has to be deep enough to be worth having --
    // this fails if anyone shrinks it to a token value.
    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('closed')
  })

  it('does not close, and does not throw, for an id another origin owns', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    await expect(t.release(OTHER, handle.id)).resolves.toBeUndefined()

    // Silence is not permission: the handle is untouched and still its owner's.
    expect(destroy).not.toHaveBeenCalled()
    expect(t.lookup(APP, handle.id).id).toBe(handle.id)
  })
})

describe('a resource that dies on its own (SSTcpSocket close table)', () => {
  it('rejects closed with the code the resource layer reports', async () => {
    const t = table()
    const handle = acquireSocket(t)

    t.fail(APP, handle.id, 'reset', 'ECONNRESET')

    const error = await rejection(handle.closed)
    expect(error.code).toBe('reset')
    expect(error.platformCode).toBe('ECONNRESET')
  })

  it('does not tell the destroy callback to touch the wire', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })

    t.fail(APP, handle.id, 'reset')

    // The peer already sent the RST. A FIN here would be a write to a dead fd.
    expect(destroy).toHaveBeenCalledWith('failed')
  })

  it('rejects pending operations with the same code', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    t.fail(APP, handle.id, 'reset')

    expect((await rejection(pending)).code).toBe('reset')
  })

  it('cascades to sockets a failed server produced', async () => {
    const t = table()
    const acceptedDestroy = spyDestroy()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: server.id, destroy: acceptedDestroy })

    t.fail(APP, server.id, 'internal')

    expect(acceptedDestroy).toHaveBeenCalledWith('failed')
    expect(t.counts(APP).handles).toBe(0)
  })

  it('is ownership-checked like every other operation', () => {
    const t = table()
    const handle = acquireSocket(t)

    expect(thrown(() => t.fail(OTHER, handle.id, 'reset')).code).toBe('denied')
    expect(t.lookup(APP, handle.id).id).toBe(handle.id)
  })
})

describe('revocation does not wait for a teardown it cannot bound', () => {
  it('settles the revoke promise even when a destroy never completes', async () => {
    const t = table()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: never })

    // The broker awaits this on the UI thread to update the permissions panel.
    // MessagePortMain teardown's failure mode is silence, not an error, so a
    // revoke that awaits it is T11b arriving through the door this module was
    // built to close.
    const outcome = await outcomeNow(t.revoke(APP, TCP_GRANT))

    expect(outcome.state).toBe('resolved')
  })
})

describe('session teardown', () => {
  it('closes gracefully, not abruptly', async () => {
    const t = table()
    const destroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy })

    await t.dropOrigin(APP)

    // 'revoked' means RST with buffered data discarded. A user clicking a link
    // away from the torrent app must not corrupt a half-written piece.
    expect(destroy).toHaveBeenCalledWith('sessionEnded')
  })

  it('refuses a handle registered after the teardown began', async () => {
    const t = table()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: never })

    const dropping = t.dropOrigin(APP)
    // An fs.userSelected picker resolving one tick late. SSFileHandle requires
    // these not to survive the session.
    const late = thrown(() => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop }))

    expect(late.code).toBe('revoked')
    void dropping
  })
})

describe('limits the first suite left unpinned', () => {
  it('counts in-flight operations per origin, not globally (T11b)', async () => {
    const t = table()
    const mine = acquireSocket(t, APP)
    const theirs = acquireSocket(t, OTHER)
    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      void t.run(APP, { on: 'handle', handleId: mine.id }, never).catch(() => {})
    }

    // A global counter here means one origin's 256 slow reads make EVERY other
    // tab fail, and the failure is attributed to the victim.
    await expect(t.run(OTHER, { on: 'handle', handleId: theirs.id }, async () => 'ok')).resolves.toBe('ok')
  })

  it('does not let identity handles consume the socket budget', () => {
    const t = table()
    const open = (): unknown => t.acquire({ origin: APP, kind: 'identity', authorisedBy: { by: 'grant', grantId: 'grant-id' }, destroy: noop })
    for (let i = 0; i < LIMITS.concurrentFileHandles; i += 1) {
      open()
    }

    // SSLimits caps nothing for IdentityHandle. A backstop on TOTAL rows lets
    // the uncapped kind eat the capped kinds' budgets, which is the reverse of
    // what a backstop is for.
    expect(thrown(open).code).toBe('limit')
    expect(() => acquireSocket(t)).not.toThrow()
    expect(() => t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: noop })).not.toThrow()
  })

  it('reports the file count it enforces against', () => {
    const t = table()
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'grant', grantId: FS_GRANT }, destroy: noop })
    t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop })

    expect(t.counts(APP).files).toBe(2)
  })

  it('destroys the resource a refused DERIVED acquisition was handed', () => {
    const t = table()
    const server = t.acquire({ origin: APP, kind: 'tcpServer', authorisedBy: { by: 'grant', grantId: 'grant-tcp-listen' }, destroy: noop })
    const destroy = spyDestroy()

    thrown(() => t.acquireDerived({ origin: OTHER, kind: 'tcpSocket', parentId: server.id, destroy }))

    // Connect repeatedly to a server whose grant was just withdrawn and every
    // accepted-then-refused socket leaks an fd while the table reports room.
    expect(destroy).toHaveBeenCalledWith('failed')
  })

  it('only derives the pair the specification describes', () => {
    const t = table()
    const picked = t.acquire({ origin: APP, kind: 'file', authorisedBy: { by: 'userSelected' }, destroy: noop })

    // Inheriting `userSelected` onto a socket would put it in no grant's set,
    // where no revoke could ever reach it.
    expect(thrown(() => t.acquireDerived({ origin: APP, kind: 'tcpSocket', parentId: picked.id, destroy: noop })).code).toBe('internal')
  })
})

describe('broker faults are always logged (SSErrors: internal is always logged)', () => {
  it('attributes a failed teardown to an origin and a handle', async () => {
    const faults: Array<{ origin: string, handleId: string | null }> = []
    const t = new HandleTable({ onFault: (fault) => { faults.push({ origin: fault.origin, handleId: fault.handleId }) } })
    const handle = t.acquire({
      origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT },
      destroy: () => { throw new Error('the socket was already gone') }
    })

    await t.release(APP, handle.id)

    // "a socket the user revoked failed to close" is useless without whose.
    expect(faults).toEqual([{ origin: APP, handleId: handle.id }])
  })

  it('logs an unkeyable origin rather than only throwing it at the app', () => {
    const faults: unknown[] = []
    const t = new HandleTable({ onFault: (fault) => { faults.push(fault.error) } })

    // origin.ts documents a detached frame resolving to about:blank as an
    // EXPECTED condition. The enum says 'internal' is always logged.
    expect(thrown(() => t.acquire({ origin: 'about:blank', kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: noop })).code).toBe('internal')
    expect(faults).toHaveLength(1)
  })
})

describe('the table does not grow for origins that hold nothing', () => {
  it('does not allocate an origin table for a denied operation', async () => {
    const t = table()

    for (let i = 0; i < 50; i += 1) {
      await rejection(t.run(`https://sub${String(i)}.example`, { on: 'handle', handleId: 'deadbeef' }, never))
    }

    // lookup() documents this rule ("a read must not allocate one per origin
    // that merely asked"); run() has to obey it too, or the rule is decorative.
    expect(t.originCount()).toBe(0)
  })

  it('reclaims a grant bucket when its last handle closes', async () => {
    const t = table()
    for (let i = 0; i < 200; i += 1) {
      const h = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: `g-${String(i)}` }, destroy: noop })
      await t.release(APP, h.id)
    }

    expect(t.counts(APP).grants).toBe(0)
  })
})

describe('what may cross to a renderer', () => {
  it('projects a handle down to its id and nothing else', () => {
    const t = table()
    const handle = acquireSocket(t)

    const wire = toWire(handle)

    // `closed` is a Promise and is not structured-cloneable; `authorisedBy`
    // carries a grant-ledger id the page has no use for. Spreading the entry
    // into a ResponseEnvelope is the path of least resistance and the wrong
    // one, so the right one is a function.
    expect(Object.keys(wire)).toEqual(['id'])
    expect(wire.id).toBe(handle.id)
  })

  it('finishes the cascade even when an abort listener throws', async () => {
    const t = table()
    const first = acquireSocket(t)
    const secondDestroy = spyDestroy()
    t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy: secondDestroy })

    const pending = t.run(APP, { on: 'handle', handleId: first.id }, async (signal) => {
      // Broker code. Node routes a throw from an abort listener to
      // emitUncaughtException, which would abandon the rest of the sweep.
      signal.addEventListener('abort', () => { throw new Error('listener blew up') })
      return await never<string>()
    })
    await Promise.resolve()

    await t.revoke(APP, TCP_GRANT)

    // The throw reaches Node's uncaughtException handler, not this module -- an
    // EventTarget dispatches out of band, so a try/catch around abort() would
    // catch nothing. What must hold is that the sweep is not abandoned
    // mid-cascade, leaving later handles live after a revoke.
    expect((await rejection(pending)).code).toBe('revoked')
    expect(secondDestroy).toHaveBeenCalledWith('revoked')
    expect(t.counts(APP).handles).toBe(0)
  })
})
