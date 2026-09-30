import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import dc, { channel, hasSubscribers, subscribe, tracingChannel, unsubscribe } from '../diagnostics-channel.js'
import { AsyncLocalStorage } from '../async-hooks.js'
import { collectGarbage } from '../../tests/support/collect-garbage.js'

const real = createRequire(import.meta.url)('node:diagnostics_channel') as typeof dc

describe('diagnostics_channel', () => {
  it('returns one channel per name, and reports subscribers', () => {
    const one = channel('test:same')
    expect(channel('test:same')).toBe(one)
    expect(one.hasSubscribers).toBe(false)
    const seen: unknown[] = []
    const fn = (message: unknown, name: string | symbol): void => { seen.push([message, name]) }
    subscribe('test:same', fn)
    expect(hasSubscribers('test:same')).toBe(true)
    one.publish({ a: 1 })
    expect(seen).toEqual([[{ a: 1 }, 'test:same']])
    expect(unsubscribe('test:same', fn)).toBe(true)
    expect(unsubscribe('test:same', fn)).toBe(false)
    expect(hasSubscribers('test:same')).toBe(false)
  })

  it('agrees with Node on the observable protocol', () => {
    const ours: unknown[] = []
    const theirs: unknown[] = []
    channel('test:node').subscribe((m) => ours.push(m))
    real.channel('test:node').subscribe((m) => theirs.push(m))
    for (const c of [channel('test:node'), real.channel('test:node')]) { c.publish(1); c.publish('two') }
    expect(ours).toEqual(theirs)
    expect(typeof channel(Symbol('s')).name).toBe('symbol')
    expect(() => channel(1 as unknown as string)).toThrow(/channel/)
  })

  it('a throwing subscriber does not stop the others and surfaces on the next tick', async () => {
    const seen: string[] = []
    const errors: unknown[] = []
    const c = channel('test:throws')
    c.subscribe(() => { throw new Error('bad') })
    c.subscribe(() => { seen.push('second') })
    const originalNextTick = globalThis.process.nextTick
    globalThis.process.nextTick = ((fn: () => void) => { try { fn() } catch (error) { errors.push(error) } }) as typeof originalNextTick
    try { c.publish(1) } finally { globalThis.process.nextTick = originalNextTick }
    expect(seen).toEqual(['second'])
    expect((errors[0] as Error).message).toBe('bad')
  })

  it('runStores runs the function inside each bound store, holding the transformed data', () => {
    const store = new AsyncLocalStorage<{ id: number }>()
    const c = channel('test:stores')
    c.bindStore(store as never, (data) => ({ id: (data as { id: number }).id + 1 }))
    expect(c.hasSubscribers).toBe(true)
    const inside = c.runStores({ id: 1 }, () => store.getStore())
    expect(inside).toEqual({ id: 2 })
    expect(store.getStore()).toBeUndefined()
    expect(c.unbindStore(store as never)).toBe(true)
  })

  it('tracingChannel publishes start, end and error around traceSync', () => {
    const tc = tracingChannel('test:sync')
    const events: string[] = []
    tc.subscribe({
      start: () => events.push('start'), end: () => events.push('end'), error: (c) => events.push(`error:${(c as { error: Error }).error.message}`),
      asyncStart: () => events.push('asyncStart'), asyncEnd: () => events.push('asyncEnd')
    })
    expect(tc.traceSync((a: number) => a * 2, {}, undefined, 4 as never)).toBe(8)
    expect(() => tc.traceSync(() => { throw new Error('x') })).toThrow('x')
    expect(events).toEqual(['start', 'end', 'start', 'error:x', 'end'])
  })

  it('tracePromise and traceCallback publish the async pair', async () => {
    const tc = tracingChannel('test:async')
    const events: string[] = []
    tc.subscribe({ start: () => events.push('start'), end: () => events.push('end'), asyncStart: () => events.push('asyncStart'), asyncEnd: () => events.push('asyncEnd'), error: () => events.push('error') })
    await expect(tc.tracePromise(async () => 'ok')).resolves.toBe('ok')
    expect(events).toEqual(['start', 'end', 'asyncStart', 'asyncEnd'])
    events.length = 0
    await expect(tc.tracePromise(async () => { throw new Error('no') })).rejects.toThrow('no')
    expect(events).toEqual(['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
    events.length = 0
    const done = vi.fn()
    tc.traceCallback((cb: (e: unknown, r: unknown) => void) => { cb(null, 5) }, -1, {}, undefined, done as never)
    expect(done).toHaveBeenCalledWith(null, 5)
    expect(events).toEqual(['start', 'asyncStart', 'asyncEnd', 'end'])
  })

  it('unsubscribe of a tracing channel reports whether every handler was removed', () => {
    const tc = tracingChannel('test:unsub')
    const handlers = { start: () => {}, end: () => {} }
    tc.subscribe(handlers)
    expect(tc.hasSubscribers).toBe(true)
    expect(tc.unsubscribe(handlers)).toBe(true)
    expect(tc.unsubscribe(handlers)).toBe(false)
    expect(tc.hasSubscribers).toBe(false)
  })

  it('default export exposes the module surface', () => {
    for (const name of ['channel', 'hasSubscribers', 'subscribe', 'unsubscribe', 'tracingChannel', 'Channel']) expect(typeof (dc as unknown as Record<string, unknown>)[name]).toBe('function')
  })

  it('a subscribed channel survives garbage collection, and is released after the last unsubscribe', async () => {
    const seen: unknown[] = []
    const fn = (message: unknown): void => { seen.push(message) }
    subscribe('test:gc-subscribed', fn)
    const store = new AsyncLocalStorage<number>()
    channel('test:gc-store').bindStore(store as never)
    await collectGarbage()
    channel('test:gc-subscribed').publish('kept')
    expect(seen).toEqual(['kept'])
    expect(hasSubscribers('test:gc-store')).toBe(true)
    unsubscribe('test:gc-subscribed', fn)
    const ref = new WeakRef(channel('test:gc-subscribed'))
    await collectGarbage()
    expect(ref.deref()).toBeUndefined()
  })

  it('tracePromise resolves a plain value and a foreign thenable as Node does', async () => {
    const tc = tracingChannel('test:thenable')
    const events: string[] = []
    tc.subscribe({ start: () => events.push('start'), end: () => events.push('end'), asyncStart: () => events.push('asyncStart'), asyncEnd: () => events.push('asyncEnd'), error: () => events.push('error') })
    await expect(tc.tracePromise((() => 42) as never)).resolves.toBe(42)
    expect(events).toEqual(['start', 'end', 'asyncStart', 'asyncEnd'])
    const thenable = { then: (resolve: (value: string) => void) => { resolve('later') } }
    await expect(tc.tracePromise((() => thenable) as never)).resolves.toBe('later')
    const rejecting = { then: (_resolve: unknown, reject: (error: Error) => void) => { reject(new Error('refused')) } }
    await expect(tc.tracePromise((() => rejecting) as never)).rejects.toThrow('refused')
  })
})
