import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../contracts/index.js'
import type { OrivonError } from '../contracts/index.js'
import { HandleTable } from './handles.js'
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

    expect((await rejection(t.release(OTHER, handle.id))).code).toBe('denied')
    expect(destroy).not.toHaveBeenCalled()
    // Still usable by its owner, which is the half a "rejected" check that a
    // silent no-op would also satisfy -- both halves matter.
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

  it('bounds the total number of rows, including kinds the specification caps nowhere', () => {
    const t = table()
    const open = (): unknown => t.acquire({ origin: APP, kind: 'identity', authorisedBy: { by: 'grant', grantId: 'grant-id' }, destroy: noop })
    for (let i = 0; i < LIMITS.concurrentSockets + LIMITS.concurrentFileHandles; i += 1) {
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
    expect(destroy).toHaveBeenCalledWith('closed')
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
    expect(picked).toHaveBeenCalledWith('revoked')
    expect(thrown(() => t.lookup(APP, handle.id)).code).toBe('denied')
  })

  it('closes grant-authorised handles and pending operations on session teardown', async () => {
    const t = table()
    const destroy = spyDestroy()
    const handle = t.acquire({ origin: APP, kind: 'tcpSocket', authorisedBy: { by: 'grant', grantId: TCP_GRANT }, destroy })
    const pending = t.run(APP, { on: 'handle', handleId: handle.id }, never)

    await t.dropOrigin(APP)

    expect(destroy).toHaveBeenCalledWith('revoked')
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
