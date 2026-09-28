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
  const pending = new Set<unknown>()
  const release = (id: unknown): void => { if (pending.delete(id)) liveness.unref() }

  if (setTimeoutRaw !== undefined && clearTimeoutRaw !== undefined) {
    scope.setTimeout = (handler, ms, ...args) => {
      const id: unknown = setTimeoutRaw(() => { release(id); handler(...(args as [])) }, ms)
      pending.add(id)
      liveness.ref()
      return id
    }
    scope.clearTimeout = (id) => { clearTimeoutRaw(id); release(id) }
  }
  if (setIntervalRaw !== undefined && clearIntervalRaw !== undefined) {
    scope.setInterval = (handler, ms, ...args) => {
      const id = setIntervalRaw(() => { handler(...(args as [])) }, ms)
      pending.add(id)
      liveness.ref()
      return id
    }
    scope.clearInterval = (id) => { clearIntervalRaw(id); release(id) }
  }
  if (setImmediateRaw !== undefined && clearImmediateRaw !== undefined) {
    scope.setImmediate = (handler, ...args) => {
      const id: unknown = setImmediateRaw(() => { release(id); handler(...(args as [])) })
      pending.add(id)
      liveness.ref()
      return id
    }
    scope.clearImmediate = (id) => { clearImmediateRaw(id); release(id) }
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
