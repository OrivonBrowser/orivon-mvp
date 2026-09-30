// What keeps a forked child alive, as Node's event loop decides it: a Node
// child ends on its own once nothing is pending, with no timer, request or
// handle left and its IPC channel closed. Each source takes a reference while
// it is pending; when the count reaches zero, `onIdle` runs a turn later if
// nothing took a new one meanwhile.

export class Liveness {
  #refs = 0
  #checking = false
  readonly #onIdle: () => void
  readonly #later: (run: () => void) => void

  constructor (onIdle: () => void, later: (run: () => void) => void) {
    this.#onIdle = onIdle
    this.#later = later
  }

  ref (): void { this.#refs++ }

  unref (): void {
    this.#refs = Math.max(0, this.#refs - 1)
    this.#check()
  }

  get idle (): boolean { return this.#refs === 0 }

  #check (): void {
    if (this.#refs !== 0 || this.#checking) return
    this.#checking = true
    this.#later(() => {
      this.#checking = false
      if (this.#refs === 0) this.#onIdle()
    })
  }
}

interface TimerScope {
  setTimeout?: (handler: () => void, ms?: number, ...args: unknown[]) => unknown
  clearTimeout?: (id: unknown) => void
  setInterval?: (handler: () => void, ms?: number, ...args: unknown[]) => unknown
  clearInterval?: (id: unknown) => void
  fetch?: (...args: never[]) => Promise<unknown>
  setImmediate?: (handler: () => void, ...args: unknown[]) => unknown
  clearImmediate?: (id: unknown) => void
}

/**
 * A timer, interval or immediate as Node returns it: `ref`, `unref`, `hasRef`, `refresh` (timers) and
 * `close`, and a number when asked for one. It counts towards the child's liveness while it is pending and
 * ref'd. Libraries call `timer.unref()` on a keep-alive and `timer.refresh()` on a ping, so a bare id
 * would throw in them.
 */
class Tracked {
  readonly #liveness: Liveness
  readonly #arm: () => unknown
  readonly #disarm: (raw: unknown) => void
  readonly #repeats: boolean
  readonly #registry: Map<number, Tracked>
  readonly #onFire: () => void
  readonly id: number
  #raw: unknown
  #pending = false
  #refed = true

  constructor (id: number, liveness: Liveness, repeats: boolean, arm: (fire: () => void) => unknown, disarm: (raw: unknown) => void, registry: Map<number, Tracked>, onFire: () => void) {
    this.id = id
    this.#liveness = liveness
    this.#repeats = repeats
    this.#registry = registry
    this.#onFire = onFire
    this.#disarm = disarm
    this.#arm = () => arm(() => { this.#fired() })
    this.#start()
  }

  #fired (): void {
    if (!this.#repeats) this.#settle()
    this.#onFire()
  }

  #start (): void {
    this.#raw = this.#arm()
    this.#registry.set(this.id, this)
    if (this.#pending) return
    this.#pending = true
    if (this.#refed) this.#liveness.ref()
  }

  #settle (): void {
    if (!this.#pending) return
    this.#pending = false
    this.#registry.delete(this.id)
    if (this.#refed) this.#liveness.unref()
  }

  ref (): this {
    if (!this.#refed) {
      this.#refed = true
      if (this.#pending) this.#liveness.ref()
    }
    return this
  }

  unref (): this {
    if (this.#refed) {
      this.#refed = false
      if (this.#pending) this.#liveness.unref()
    }
    return this
  }

  hasRef (): boolean { return this.#refed }

  refresh (): this {
    if (this.#pending) this.#disarm(this.#raw)
    this.#start()
    return this
  }

  close (): this {
    if (this.#pending) this.#disarm(this.#raw)
    this.#settle()
    return this
  }

  [Symbol.toPrimitive] (): number { return this.id }
}

/**
 * Makes the scope's timers and fetch take a reference while pending. Returns
 * the unwrapped setTimeout, for scheduling that must not keep the child alive.
 */
export function trackScope (scope: TimerScope, liveness: Liveness): (run: () => void) => void {
  const setTimeoutRaw = scope.setTimeout?.bind(scope)
  const clearTimeoutRaw = scope.clearTimeout?.bind(scope)
  const setIntervalRaw = scope.setInterval?.bind(scope)
  const clearIntervalRaw = scope.clearInterval?.bind(scope)
  const fetchRaw = scope.fetch?.bind(scope)
  const setImmediateRaw = scope.setImmediate
  const clearImmediateRaw = scope.clearImmediate
  // What `clearTimeout(Number(timer))` finds: every pending timer by the number it reports.
  const byId = new Map<number, Tracked>()
  let nextId = 1
  const make = (repeats: boolean, arm: (fire: () => void) => unknown, disarm: (raw: unknown) => void, handler: (...args: never[]) => void, args: unknown[]): Tracked => {
    return new Tracked(nextId++, liveness, repeats, arm, disarm, byId, () => { handler(...(args as [])) })
  }
  const find = (id: unknown): Tracked | undefined => id instanceof Tracked ? id : typeof id === 'number' || typeof id === 'string' ? byId.get(Number(id)) : undefined

  if (setTimeoutRaw !== undefined && clearTimeoutRaw !== undefined) {
    scope.setTimeout = (handler, ms, ...args) => make(false, (fire) => setTimeoutRaw(fire, ms), clearTimeoutRaw, handler, args)
    scope.clearTimeout = (id) => { find(id)?.close() }
  }
  if (setIntervalRaw !== undefined && clearIntervalRaw !== undefined) {
    scope.setInterval = (handler, ms, ...args) => make(true, (fire) => setIntervalRaw(fire, ms), clearIntervalRaw, handler, args)
    scope.clearInterval = (id) => { find(id)?.close() }
  }
  if (setImmediateRaw !== undefined && clearImmediateRaw !== undefined) {
    scope.setImmediate = (handler, ...args) => make(false, (fire) => setImmediateRaw(fire), clearImmediateRaw, handler, args)
    scope.clearImmediate = (id) => { find(id)?.close() }
  }
  if (fetchRaw !== undefined) {
    scope.fetch = async (...args: never[]) => {
      liveness.ref()
      try {
        return await fetchRaw(...args)
      } finally {
        liveness.unref()
      }
    }
  }
  return (run) => { (setTimeoutRaw ?? ((next: () => void) => { queueMicrotask(next) }))(run, 0) }
}
