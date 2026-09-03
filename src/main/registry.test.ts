import { describe, expect, it, vi } from 'vitest'
import { runAfterReady, runBeforeReady, type Subsystem, type SubsystemContext } from './registry.js'
import type { Broker } from '../broker/index.js'

// The registry never touches Electron OR the broker at runtime --
// SubsystemContext's App and Broker fields are both type-only imports,
// erased by verbatimModuleSyntax -- so plain objects stand in for both here.
// That erasure is the whole reason this is unit testable.
const ctx = { app: {} } as unknown as SubsystemContext
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

  it('reports a throwing subsystem instead of propagating', () => {
    const boom = new Error('scheme registration failed')
    const failures = runBeforeReady([{ name: 'broken', beforeReady: () => { throw boom } }])
    expect(failures).toEqual([{ name: 'broken', phase: 'beforeReady', error: boom }])
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

  it('reports a rejecting subsystem instead of propagating', async () => {
    const boom = new Error('broker failed to start')
    const failures = await runAfterReady(
      [{ name: 'broker', afterReady: async () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom }])
  })

  it('reports a synchronously throwing afterReady the same way', async () => {
    const boom = new Error('sync throw')
    const failures = await runAfterReady(
      [{ name: 'broker', afterReady: () => { throw boom } }],
      ctx
    )
    expect(failures).toEqual([{ name: 'broker', phase: 'afterReady', error: boom }])
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
  // ctx survives being written to by an earlier subsystem and read by a
  // later one in the same run, which is the only mechanism that makes that
  // possible.
  it('lets an earlier subsystem publish the broker on ctx for a later one to read', async () => {
    const seenByLater: Array<Broker | undefined> = []
    const withBroker: SubsystemContext = { app: ctx.app }
    await runAfterReady([
      { name: 'broker', afterReady: (c) => { c.broker = fakeBroker } },
      { name: 'later', afterReady: (c) => { seenByLater.push(c.broker) } }
    ], withBroker)
    expect(seenByLater).toEqual([fakeBroker])
  })
})
