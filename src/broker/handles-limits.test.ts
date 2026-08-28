import { describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../contracts/index.js'
import { HandleTable } from './handles.js'
import { toWire } from './handle-contracts.js'
import {
  APP,
  FS_GRANT,
  OTHER,
  TCP_GRANT,
  acquireSocket,
  never,
  noop,
  outcomeNow,
  rejection,
  spyDestroy,
  table,
  thrown
} from './handles.test-helpers.js'

// The budget/hygiene half of the handle table's suite (split out of one file
// that exceeded docs/development/code-guidelines.md's 800-line test limit --
// see ./handles.test.ts for the cascade/lifecycle half).
//
// Covers the failure the cascade half does not:
//
//   T11   an origin holding unbounded sockets, files or in-flight calls.
//   T11b  the broker's UI thread blocked by a queue one origin filled.
//
// None of these is visible from using the product, which is why they are
// tested here at a level of detail the rest of the broker will not need.
//
// EVERY test below was checked against a deliberately-broken implementation
// (see the PR body): the in-flight cap queueing instead of rejecting, and
// (the review pass, 2026-08-27) limits and hygiene the first suite left
// unpinned -- the origin table growing for origins holding nothing, and
// 'internal' faults going unlogged. A suite that passes proves nothing until
// it has been watched to fail.

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
    // handle-store.ts. Without it an origin could hold unbounded listeners.
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
    // backstop derived from the budgets it already has. Flagged in
    // handle-store.ts.
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
})
