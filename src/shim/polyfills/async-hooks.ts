// `async_hooks` module target (module-map.ts): AsyncResource and
// AsyncLocalStorage over one table of "current stores" that a callback bound
// with AsyncResource.bind carries and restores. A page has no per-continuation
// context, so a store set by run() is visible only while its callback runs
// synchronously, and to callbacks bound to it; a continuation after an `await`
// or a timer that nothing bound sees none. README.md's Design notes say more.
// createHook returns a hook that never fires: no resource is ever reported.

import { nodeModule } from './module-proxy.js'

type Stores = ReadonlyMap<AsyncLocalStorage<unknown>, unknown>

let current: Stores = new Map()
let nextAsyncId = 2
let currentAsyncId = 1
let currentTriggerId = 0
let currentResource: object = {}

/** Runs `fn` with `stores` as the current table and the given ids, then restores what was there. */
function withContext<R> (stores: Stores, asyncId: number, triggerId: number, resource: object, fn: () => R): R {
  const saved = { stores: current, asyncId: currentAsyncId, triggerId: currentTriggerId, resource: currentResource }
  current = stores
  currentAsyncId = asyncId
  currentTriggerId = triggerId
  currentResource = resource
  try {
    return fn()
  } finally {
    current = saved.stores
    currentAsyncId = saved.asyncId
    currentTriggerId = saved.triggerId
    currentResource = saved.resource
  }
}

export class AsyncResource {
  readonly #stores: Stores
  readonly #asyncId: number
  readonly #triggerId: number

  constructor (type: string, options: number | { triggerAsyncId?: number, requireManualDestroy?: boolean } = {}) {
    if (typeof type !== 'string' || type === '') {
      throw Object.assign(new TypeError('The "type" argument must be of type string. Received ' + String(type)), { code: 'ERR_INVALID_ARG_TYPE' })
    }
    this.#stores = current
    this.#asyncId = nextAsyncId++
    this.#triggerId = typeof options === 'number' ? options : (options.triggerAsyncId ?? currentAsyncId)
  }

  runInAsyncScope<This, Args extends unknown[], R> (fn: (this: This, ...args: Args) => R, thisArg?: This, ...args: Args): R {
    return withContext(this.#stores, this.#asyncId, this.#triggerId, this, () => fn.apply(thisArg as This, args))
  }

  emitDestroy (): this { return this }
  asyncId (): number { return this.#asyncId }
  triggerAsyncId (): number { return this.#triggerId }

  bind<F extends (...args: never[]) => unknown> (fn: F, thisArg?: unknown): F & { asyncResource: AsyncResource } {
    if (typeof fn !== 'function') {
      throw Object.assign(new TypeError('The "fn" argument must be of type function. Received ' + typeof fn), { code: 'ERR_INVALID_ARG_TYPE' })
    }
    const resource = this
    const bound = function (this: unknown, ...args: unknown[]): unknown {
      return resource.runInAsyncScope(fn as unknown as (...rest: unknown[]) => unknown, thisArg === undefined ? this : thisArg, ...args)
    }
    Object.defineProperties(bound, {
      length: { configurable: true, enumerable: false, value: fn.length, writable: false },
      asyncResource: { configurable: true, enumerable: true, value: this, writable: true }
    })
    return bound as unknown as F & { asyncResource: AsyncResource }
  }

  static bind<F extends (...args: never[]) => unknown> (fn: F, type?: string, thisArg?: unknown): F & { asyncResource: AsyncResource } {
    return new AsyncResource(type ?? (fn.name || 'bound-anonymous-fn')).bind(fn, thisArg)
  }
}

export class AsyncLocalStorage<T> {
  static bind<F extends (...args: never[]) => unknown> (fn: F): F {
    return AsyncResource.bind(fn) as F
  }

  static snapshot (): <R, Args extends unknown[]> (fn: (...args: Args) => R, ...args: Args) => R {
    const resource = new AsyncResource('AsyncLocalStorageSnapshot')
    return (fn, ...args) => resource.runInAsyncScope(fn, undefined, ...args)
  }

  #enabled = true

  getStore (): T | undefined {
    return this.#enabled ? current.get(this as AsyncLocalStorage<unknown>) as T | undefined : undefined
  }

  run<R, Args extends unknown[]> (store: T, fn: (...args: Args) => R, ...args: Args): R {
    this.#enabled = true
    const stores = new Map(current).set(this as AsyncLocalStorage<unknown>, store)
    return withContext(stores, currentAsyncId, currentTriggerId, currentResource, () => fn(...args))
  }

  exit<R, Args extends unknown[]> (fn: (...args: Args) => R, ...args: Args): R {
    const stores = new Map(current)
    stores.delete(this as AsyncLocalStorage<unknown>)
    return withContext(stores, currentAsyncId, currentTriggerId, currentResource, () => fn(...args))
  }

  /** Sets the store until something restores the table: the end of an enclosing run() or bound callback. Outside one, it stays for the page's whole life, as long as no other call replaces it. */
  enterWith (store: T): void {
    this.#enabled = true
    current = new Map(current).set(this as AsyncLocalStorage<unknown>, store)
  }

  disable (): void {
    this.#enabled = false
    const stores = new Map(current)
    stores.delete(this as AsyncLocalStorage<unknown>)
    current = stores
  }
}

export function executionAsyncId (): number { return currentAsyncId }
export function triggerAsyncId (): number { return currentTriggerId }
export function executionAsyncResource (): object { return currentResource }

export interface AsyncHook {
  enable (): AsyncHook
  disable (): AsyncHook
}

export function createHook (_callbacks: object): AsyncHook {
  const hook: AsyncHook = { enable: () => hook, disable: () => hook }
  return hook
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/async-hooks.js'

export default nodeModule('async_hooks', { AsyncResource, AsyncLocalStorage, executionAsyncId, triggerAsyncId, executionAsyncResource, createHook })
