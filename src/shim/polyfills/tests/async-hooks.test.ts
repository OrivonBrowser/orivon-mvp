import { describe, expect, it } from 'vitest'
import hooks, { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, executionAsyncResource, triggerAsyncId } from '../async-hooks.js'

describe('AsyncResource', () => {
  it('runInAsyncScope calls fn with this and args, returning its result', () => {
    const resource = new AsyncResource('TEST')
    const thisArg = { v: 1 }
    expect(resource.runInAsyncScope(function (this: { v: number }, a: number, b: number) { return this.v + a + b }, thisArg, 2, 3)).toBe(6)
  })

  it('runs with its own async id, restoring the outer one after', () => {
    const before = executionAsyncId()
    const resource = new AsyncResource('TEST')
    expect(resource.asyncId()).toBeGreaterThan(1)
    expect(resource.runInAsyncScope(() => executionAsyncId())).toBe(resource.asyncId())
    expect(resource.runInAsyncScope(() => triggerAsyncId())).toBe(resource.triggerAsyncId())
    expect(resource.runInAsyncScope(() => executionAsyncResource())).toBe(resource)
    expect(executionAsyncId()).toBe(before)
  })

  it('restores the outer context when fn throws', () => {
    const resource = new AsyncResource('TEST')
    expect(() => resource.runInAsyncScope(() => { throw new Error('x') })).toThrow('x')
    expect(executionAsyncId()).toBe(1)
  })

  it('emitDestroy returns the resource; a bad type throws as Node does', () => {
    const resource = new AsyncResource('TEST')
    expect(resource.emitDestroy()).toBe(resource)
    expect(() => new AsyncResource(undefined as unknown as string)).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
  })

  it('bind keeps the length, exposes asyncResource, and uses the call\'s this when none is given', () => {
    const resource = new AsyncResource('TEST')
    const bound = resource.bind(function (this: unknown, a: number, _b: number) { return [this, a] })
    expect(bound.length).toBe(2)
    expect(bound.asyncResource).toBe(resource)
    const holder = { bound }
    expect(holder.bound(7, 8)).toEqual([holder, 7])
    const fixed = AsyncResource.bind(function (this: unknown) { return this }, 'X', 'me')
    expect(fixed()).toBe('me')
  })

  it('a stream-response wrapper like on-finished\'s works: bind then call later', () => {
    const seen: number[] = []
    const callback = new AsyncResource('on-finished').bind(() => { seen.push(executionAsyncId()) })
    callback()
    expect(seen).toHaveLength(1)
  })
})

describe('AsyncLocalStorage', () => {
  it('holds a store for the synchronous run of its callback and no longer', () => {
    const als = new AsyncLocalStorage<string>()
    expect(als.getStore()).toBeUndefined()
    const result = als.run('a', (x: number) => [als.getStore(), x], 5)
    expect(result).toEqual(['a', 5])
    expect(als.getStore()).toBeUndefined()
  })

  it('nests, and exit clears', () => {
    const als = new AsyncLocalStorage<string>()
    als.run('outer', () => {
      als.run('inner', () => expect(als.getStore()).toBe('inner'))
      expect(als.getStore()).toBe('outer')
      als.exit(() => expect(als.getStore()).toBeUndefined())
      expect(als.getStore()).toBe('outer')
    })
  })

  it('two storages do not see each other', () => {
    const a = new AsyncLocalStorage<number>()
    const b = new AsyncLocalStorage<number>()
    a.run(1, () => b.run(2, () => { expect([a.getStore(), b.getStore()]).toEqual([1, 2]) }))
  })

  it('a callback bound inside run sees the store when called later, from outside', () => {
    const als = new AsyncLocalStorage<string>()
    const bound = als.run('captured', () => AsyncLocalStorage.bind(() => als.getStore()))
    expect(als.getStore()).toBeUndefined()
    expect(bound()).toBe('captured')
  })

  it('snapshot captures every store at the moment it is taken', () => {
    const als = new AsyncLocalStorage<string>()
    const run = als.run('s', () => AsyncLocalStorage.snapshot())
    expect(run(() => als.getStore())).toBe('s')
  })

  it('honest limit: the store does not follow an await, and getStore says so with undefined', async () => {
    const als = new AsyncLocalStorage<string>()
    const after = await als.run('x', async () => { await Promise.resolve(); return als.getStore() })
    expect(after).toBeUndefined()
  })

  it('enterWith sets the store until replaced, and disable clears it', () => {
    const als = new AsyncLocalStorage<string>()
    als.enterWith('e')
    expect(als.getStore()).toBe('e')
    als.disable()
    expect(als.getStore()).toBeUndefined()
  })
})

describe('createHook', () => {
  it('returns an inert hook whose enable and disable chain', () => {
    const hook = createHook({ init () { throw new Error('never') } })
    expect(hook.enable()).toBe(hook)
    expect(hook.disable()).toBe(hook)
  })

  it('default export carries the module surface', () => {
    for (const name of ['AsyncResource', 'AsyncLocalStorage', 'createHook', 'executionAsyncId']) expect(typeof (hooks as unknown as Record<string, unknown>)[name]).toBe('function')
  })
})
