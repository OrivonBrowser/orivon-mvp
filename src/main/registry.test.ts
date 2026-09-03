import { describe, expect, it, vi } from 'vitest'
import {
  createSubsystemContext, criticalFailureMessage, publishBroker, runAfterReady, runBeforeReady,
  type Subsystem
} from './registry.js'
import type { App } from 'electron'
import type { Broker } from '../broker/index.js'

// SubsystemContext's App and Broker fields are both type-only imports,
// erased by verbatimModuleSyntax, so plain objects stand in for both below.
// What this file actually proves: ctx survives being written by an earlier
// subsystem and read by a later one in the same run.
const fakeApp = {} as unknown as App
const ctx = createSubsystemContext(fakeApp)
const fakeBroker = { marker: 'the-one-broker' } as unknown as Broker

describe('runBeforeReady', () => {
  it('runs every beforeReady in list order', () => {
    const order: string[] = []
    const make = (name: string): Subsystem => ({ name, beforeReady: () => { order.push(name) } })
    runBeforeReady([make('a'), make('b'), make('c')])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('skips a subsystem that declares no beforeReady', () => {
    expect(runBeforeReady([{ name: 'passive' }])).toEqual([])
  })

  it('returns no failures for an empty list', () => {
    expect(runBeforeReady([])).toEqual([])
  })

  it('reports a throwing subsystem instead of propagating, tagged non-critical by default', () => {
    const boom = new Error('scheme registration failed')
    const failures = runBeforeReady([{ name: 'broken', beforeReady: () => { throw boom } }])
    expect(failures).toEqual([{ name: 'broken', phase: 'beforeReady', error: boom, critical: false }])
  })

  it("carries a critical subsystem's own critical: true into the failure record", () => {
    const boom = new Error('scheme registration failed')
    const failures = runBeforeReady([{ name: 'broken', critical: true, beforeReady: () => { throw boom } }])
    expect(failures).toEqual([{ name: 'broken', phase: 'beforeReady', error: boom, critical: true }])
  })

  // A subsystem that fails to start may be a capability enforcing nothing.
  // One broken subsystem must not silently prevent the rest from registering.
  it('still runs later subsystems after one throws', () => {
    const after = vi.fn()
    runBeforeReady([
      { name: 'broken', beforeReady: () => { throw new Error('x') } },
      { name: 'later', beforeReady: after }
    ])
    expect(after).toHaveBeenCalledOnce()
  })
})

describe('runAfterReady', () => {
  it('awaits each subsystem in list order, not concurrently', async () => {
    const order: string[] = []
    const slow: Subsystem = {
      name: 'slow',
      afterReady: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push('slow')
      }
    }
    const fast: Subsystem = { name: 'fast', afterReady: () => { order.push('fast') } }
    await runAfterReady([slow, fast], ctx)
    expect(order).toEqual(['slow', 'fast'])
  })

  it('passes the context through', async () => {
    const seen = vi.fn()
    await runAfterReady([{ name: 'a', afterReady: seen }], ctx)
    expect(seen).toHaveBeenCalledWith(ctx)
  })

  it('skips a subsystem that declares no afterReady', async () => {
    expect(await runAfterReady([{ name: 'passive' }], ctx)).toEqual([])
  })

  it('returns no failures for an empty list', async () => {
    expect(await runAfterReady([], ctx)).toEqual([])
  })

  it('reports a rejecting subsystem instead of propagating, tagged non-critical by default', async () => {
    const boom = new Error('broker failed to start')
    const failures = await runAfterReady(
      [{ name: 'broker', afterReady: async () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom, critical: false }])
  })

  it("carries a critical subsystem's own critical: true into a rejection's failure record", async () => {
    const boom = new Error('broker failed to start')
    const failures = await runAfterReady(
      [{ name: 'broker', critical: true, afterReady: async () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom, critical: true }])
  })

  it('reports a synchronously throwing afterReady the same way', async () => {
    const boom = new Error('sync throw')
    const failures = await runAfterReady(
      [{ name: 'broker', afterReady: () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom, critical: false }])
  })

  it('still runs later subsystems after one rejects', async () => {
    const after = vi.fn()
    await runAfterReady([
      { name: 'broken', afterReady: () => { throw new Error('x') } },
      { name: 'later', afterReady: after }
    ], ctx)
    expect(after).toHaveBeenCalledOnce()
  })

  it('collects failures from several subsystems', async () => {
    const failures = await runAfterReady([
      { name: 'a', afterReady: () => { throw new Error('a') } },
      { name: 'ok', afterReady: () => {} },
      { name: 'b', afterReady: () => { throw new Error('b') } }
    ], ctx)
    expect(failures.map((f) => f.name)).toEqual(['a', 'b'])
  })

  // A later subsystem (the app loader, the trust indicator) needs the SAME
  // broker the IPC subsystem built, never a second one -- two brokers means
  // two independent, disagreeing grant ledgers for one running app. Proves
  // ctx survives being written to by an earlier subsystem (through
  // publishBroker -- direct assignment is no longer possible, see
  // 'SubsystemContext.broker encapsulation' below) and read by a later one
  // in the same run, which is the only mechanism that makes that possible.
  it('lets an earlier subsystem publish the broker on ctx for a later one to read', async () => {
    const seenByLater: Array<Broker | undefined> = []
    const withBroker = createSubsystemContext(fakeApp)
    await runAfterReady([
      { name: 'broker', afterReady: (c) => { publishBroker(c, fakeBroker) } },
      { name: 'later', afterReady: (c) => { seenByLater.push(c.broker) } }
    ], withBroker)
    expect(seenByLater).toEqual([fakeBroker])
  })
})

describe('publishBroker', () => {
  it('sets ctx.broker so a later reader sees it', () => {
    const fresh = createSubsystemContext(fakeApp)
    publishBroker(fresh, fakeBroker)
    expect(fresh.broker).toBe(fakeBroker)
  })

  // The failure this guards against is silent, not loud: a second subsystem
  // assigning c.broker directly would type-check and would just overwrite
  // the first broker, reproducing the two-disagreeing-grant-ledgers problem
  // SubsystemContext.broker's own doc comment exists to prevent. Routing the
  // write through here turns that into an immediate throw instead.
  it('throws if a broker was already published, naming the hazard', () => {
    const fresh = createSubsystemContext(fakeApp)
    publishBroker(fresh, fakeBroker)
    const second = { marker: 'a-second-broker' } as unknown as Broker
    expect(() => publishBroker(fresh, second)).toThrow(/grant ledger/)
    // The first publish is not clobbered by the failed second attempt.
    expect(fresh.broker).toBe(fakeBroker)
  })

  it('leaves ctx.broker undefined when nothing ever publishes', () => {
    const fresh = createSubsystemContext(fakeApp)
    expect(fresh.broker).toBeUndefined()
  })
})

describe('SubsystemContext.broker encapsulation', () => {
  // The hazard this whole mechanism exists to prevent: some future edit in
  // shim/, trust/ or nostr/ (or a careless change to ipc.ts itself) writes
  // `ctx.broker = someBroker` directly instead of calling publishBroker.
  // `broker` is `readonly` in the type, so ordinary code no longer compiles
  // if it tries -- this test proves the RUNTIME guarantee holds too, for
  // the case a type-level bypass (a cast, an `any`) gets past the compiler.
  // A plain object literal would silently accept the write; what
  // createSubsystemContext returns makes the write itself impossible.
  it('throws a TypeError on direct assignment, even past a type-level bypass', () => {
    const fresh = createSubsystemContext(fakeApp)
    const bypassed = fresh as unknown as { broker: Broker }
    expect(() => { bypassed.broker = fakeBroker }).toThrow(TypeError)
    // The failed assignment did not partially succeed.
    expect(fresh.broker).toBeUndefined()
  })
})

describe('criticalFailureMessage', () => {
  it('returns null when there are no failures', () => {
    expect(criticalFailureMessage([])).toBeNull()
  })

  it('returns null when every failure is non-critical', () => {
    const failures = [
      { name: 'telemetry', phase: 'afterReady' as const, error: new Error('x'), critical: false }
    ]
    expect(criticalFailureMessage(failures)).toBeNull()
  })

  // This is the case FIX 1 exists for: a critical subsystem (the broker)
  // failing must never be something only a console.error line records.
  // criticalFailureMessage is what main/index.ts checks to decide whether
  // it may still open a shell window -- proving it returns non-null here is
  // what proves the failure is no longer silent.
  it('returns a non-null message naming a critical failure', () => {
    const boom = new Error('registerBrokerIpc never ran')
    const failures = [
      { name: 'broker', phase: 'afterReady' as const, error: boom, critical: true }
    ]
    const message = criticalFailureMessage(failures)
    expect(message).not.toBeNull()
    expect(message).toMatch(/broker/)
    expect(message).toMatch(/registerBrokerIpc never ran/)
  })

  it('ignores non-critical failures alongside a critical one, but still reports the critical one', () => {
    const criticalError = new Error('broker down')
    const failures = [
      { name: 'telemetry', phase: 'afterReady' as const, error: new Error('telemetry down'), critical: false },
      { name: 'broker', phase: 'afterReady' as const, error: criticalError, critical: true }
    ]
    const message = criticalFailureMessage(failures)
    expect(message).not.toBeNull()
    expect(message).toMatch(/broker/)
    expect(message).not.toMatch(/telemetry down/)
  })
})
