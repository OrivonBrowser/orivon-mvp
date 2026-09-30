// `diagnostics_channel` module target (module-map.ts): Node's named channels,
// pure JavaScript. A channel is one object per name, held weakly so a name
// nobody keeps a reference to is collected. A subscriber that throws does not
// stop the others: its error surfaces on the next tick as an uncaught one.

import { nodeModule } from './module-proxy.js'

type Subscriber = (message: unknown, name: string | symbol) => void
type Store = { run: (context: unknown, fn: () => unknown) => unknown }
type Transform = (data: unknown) => unknown

const channels = new Map<string | symbol, WeakRef<Channel>>()

function reportLater (error: unknown): void {
  globalThis.process.nextTick(() => { throw error })
}

function assertName (name: unknown): asserts name is string | symbol {
  if (typeof name !== 'string' && typeof name !== 'symbol') {
    throw Object.assign(new TypeError(`The "channel" argument must be of type string or symbol. Received ${typeof name}`), { code: 'ERR_INVALID_ARG_TYPE' })
  }
}

function assertFunction (value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    throw Object.assign(new TypeError(`The "${label}" argument must be of type function. Received ${typeof value}`), { code: 'ERR_INVALID_ARG_TYPE' })
  }
}

export class Channel {
  readonly name: string | symbol
  #subscribers: Subscriber[] = []
  #stores = new Map<Store, Transform | undefined>()

  constructor (name: string | symbol) {
    this.name = name
  }

  get hasSubscribers (): boolean {
    return this.#subscribers.length > 0 || this.#stores.size > 0
  }

  subscribe (subscription: Subscriber): void {
    assertFunction(subscription, 'subscription')
    this.#subscribers = [...this.#subscribers, subscription]
  }

  unsubscribe (subscription: Subscriber): boolean {
    const index = this.#subscribers.indexOf(subscription)
    if (index === -1) return false
    this.#subscribers = this.#subscribers.filter((_, i) => i !== index)
    return true
  }

  publish (data: unknown): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(data, this.name)
      } catch (error) {
        reportLater(error)
      }
    }
  }

  bindStore (store: Store, transform?: Transform): void {
    this.#stores.set(store, transform)
  }

  unbindStore (store: Store): boolean {
    return this.#stores.delete(store)
  }

  /** Publishes `data`, then runs `fn` inside every bound store, each holding what its transform made of `data`. */
  runStores<R> (data: unknown, fn: (...args: never[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    let run = (): unknown => {
      this.publish(data)
      return (fn as (...rest: unknown[]) => unknown).apply(thisArg, args)
    }
    for (const [store, transform] of this.#stores) {
      const next = run
      run = () => {
        let context = data
        if (transform !== undefined) {
          try {
            context = transform(data)
          } catch (error) {
            reportLater(error)
            return next()
          }
        }
        return store.run(context, next)
      }
    }
    return run() as R
  }
}

export function channel (name: string | symbol): Channel {
  assertName(name)
  let found = channels.get(name)?.deref()
  if (found === undefined) {
    found = new Channel(name)
    channels.set(name, new WeakRef(found))
  }
  return found
}

export function hasSubscribers (name: string | symbol): boolean {
  assertName(name)
  return channels.get(name)?.deref()?.hasSubscribers ?? false
}

export function subscribe (name: string | symbol, subscription: Subscriber): void {
  channel(name).subscribe(subscription)
}

export function unsubscribe (name: string | symbol, subscription: Subscriber): boolean {
  return channel(name).unsubscribe(subscription)
}

const TRACE_EVENTS = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const
type TraceEvent = (typeof TRACE_EVENTS)[number]
type TraceContext = Record<string, unknown>
type TraceHandlers = Partial<Record<TraceEvent, Subscriber>>

export class TracingChannel {
  readonly start: Channel
  readonly end: Channel
  readonly asyncStart: Channel
  readonly asyncEnd: Channel
  readonly error: Channel

  constructor (nameOrChannels: string | Record<TraceEvent, Channel>) {
    if (typeof nameOrChannels === 'string') {
      this.start = channel(`tracing:${nameOrChannels}:start`)
      this.end = channel(`tracing:${nameOrChannels}:end`)
      this.asyncStart = channel(`tracing:${nameOrChannels}:asyncStart`)
      this.asyncEnd = channel(`tracing:${nameOrChannels}:asyncEnd`)
      this.error = channel(`tracing:${nameOrChannels}:error`)
    } else {
      this.start = nameOrChannels.start
      this.end = nameOrChannels.end
      this.asyncStart = nameOrChannels.asyncStart
      this.asyncEnd = nameOrChannels.asyncEnd
      this.error = nameOrChannels.error
    }
  }

  get hasSubscribers (): boolean {
    return TRACE_EVENTS.some((event) => this[event].hasSubscribers)
  }

  subscribe (handlers: TraceHandlers): void {
    for (const event of TRACE_EVENTS) {
      const handler = handlers[event]
      if (handler !== undefined) this[event].subscribe(handler)
    }
  }

  /** True only when every handler given was subscribed and is now removed. */
  unsubscribe (handlers: TraceHandlers): boolean {
    let all = true
    for (const event of TRACE_EVENTS) {
      const handler = handlers[event]
      if (handler !== undefined && !this[event].unsubscribe(handler)) all = false
    }
    return all
  }

  traceSync<R> (fn: (...args: never[]) => R, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]): R {
    if (!this.hasSubscribers) return (fn as (...rest: unknown[]) => R).apply(thisArg, args)
    return this.start.runStores(context, () => {
      try {
        const result = (fn as (...rest: unknown[]) => R).apply(thisArg, args)
        context.result = result
        return result
      } catch (error) {
        context.error = error
        this.error.publish(context)
        throw error
      } finally {
        this.end.publish(context)
      }
    })
  }

  tracePromise<R> (fn: (...args: never[]) => Promise<R>, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]): Promise<R> {
    if (!this.hasSubscribers) return (fn as (...rest: unknown[]) => Promise<R>).apply(thisArg, args)
    return this.start.runStores(context, () => {
      let promise: Promise<R>
      try {
        promise = (fn as (...rest: unknown[]) => Promise<R>).apply(thisArg, args)
      } catch (error) {
        context.error = error
        this.error.publish(context)
        this.end.publish(context)
        throw error
      }
      this.end.publish(context)
      const settle = (): void => {
        this.asyncStart.publish(context)
        this.asyncEnd.publish(context)
      }
      return promise.then((result) => {
        context.result = result
        settle()
        return result
      }, (error: unknown) => {
        context.error = error
        this.error.publish(context)
        settle()
        throw error
      })
    })
  }

  /** `position` is the index of the callback among `args`; the default, -1, is the last. */
  traceCallback<R> (fn: (...args: never[]) => R, position = -1, context: TraceContext = {}, thisArg?: unknown, ...args: unknown[]): R {
    if (!this.hasSubscribers) return (fn as (...rest: unknown[]) => R).apply(thisArg, args)
    const index = position < 0 ? args.length + position : position
    const callback = args[index]
    assertFunction(callback, 'callback')
    const tracing = this
    args[index] = function wrapped (this: unknown, error: unknown, result: unknown): unknown {
      if (error !== undefined && error !== null) {
        context.error = error
        tracing.error.publish(context)
      } else {
        context.result = result
      }
      return tracing.asyncStart.runStores(context, () => {
        try {
          return (callback as (...rest: unknown[]) => unknown).apply(this, arguments as unknown as unknown[])
        } finally {
          tracing.asyncEnd.publish(context)
        }
      })
    }
    return this.traceSync(fn, context, thisArg, ...args)
  }
}

export function tracingChannel (nameOrChannels: string | Record<TraceEvent, Channel>): TracingChannel {
  return new TracingChannel(nameOrChannels)
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/diagnostics-channel.js'

export default nodeModule('diagnostics_channel', { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel })
