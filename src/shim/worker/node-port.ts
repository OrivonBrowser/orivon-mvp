// Node's MessagePort shape over a web MessagePort: 'message' and
// 'messageerror' listeners get the value, not the event, and the port
// buffers what arrives until something actually listens (`start()` on the
// first 'message'/'messageerror' listener, matching MessagePort.start()'s
// own note that assigning `onmessage` does the same). A port arriving in a
// message, or passed in a transfer list, is wrapped or unwrapped one level
// into the value: its own top-level fields if it is a plain object or an
// array, never deeper, matching worker_threads.MessagePort's own shape.
// Never patch MessagePort.prototype: every other module here keeps using
// the real one, and a wrapped port is a distinct object holding one.

import { EventEmitter } from 'events'

const INTERNAL = Symbol('orivon.node-message-port')
const wrappers = new WeakMap<MessagePort, NodeMessagePort>()

/** A `{}`-literal-shaped object, never a Date, Map, RegExp, port or other class instance: those clone (or transfer) as themselves, not as a record of ports to unwrap or wrap. */
function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

/** Applies `convert` to `value` itself, then (only if unchanged) to an array or plain object's own top-level values. */
function mapOneLevel (value: unknown, convert: (item: unknown) => unknown): unknown {
  const converted = convert(value)
  if (converted !== value) return converted
  if (Array.isArray(value)) return value.map(convert)
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]))
  return value
}

function toRaw (item: unknown): unknown {
  return item instanceof NodeMessagePort ? item.rawPort() : item
}

/** Node's MessagePort/MessageChannel shape (module-map.ts's worker_threads target re-exports this as both). */
export class NodeMessagePort extends EventEmitter {
  readonly #port: MessagePort
  readonly #onActive?: ((active: boolean) => void) | undefined
  #started = false
  #refd = true
  #closed = false
  #active = false

  constructor (port: MessagePort, internal: symbol, onActive?: (active: boolean) => void) {
    if (internal !== INTERNAL) throw new TypeError('Illegal constructor')
    super()
    this.#port = port
    this.#onActive = onActive
  }

  override on (event: string | symbol, listener: (...args: any[]) => void): this {
    // super.on() first: start()'s activity check counts listeners, and this one isn't added yet until it runs.
    super.on(event, listener)
    if (event === 'message' || event === 'messageerror') this.start()
    this.#syncActive()
    return this
  }

  override once (event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener)
    if (event === 'message' || event === 'messageerror') this.start()
    this.#syncActive()
    return this
  }

  override addListener (event: string | symbol, listener: (...args: any[]) => void): this {
    return this.on(event, listener)
  }

  override removeListener (event: string | symbol, listener: (...args: any[]) => void): this {
    super.removeListener(event, listener)
    this.#syncActive()
    return this
  }

  override off (event: string | symbol, listener: (...args: any[]) => void): this {
    return this.removeListener(event, listener)
  }

  override removeAllListeners (event?: string | symbol): this {
    super.removeAllListeners(event)
    this.#syncActive()
    return this
  }

  /** Starts delivery: automatic on the first 'message'/'messageerror' listener: also callable directly, as Node's does. */
  start (): void {
    if (this.#started) return
    this.#started = true
    this.#port.onmessage = (event: MessageEvent) => {
      this.emit('message', mapOneLevel(event.data, (item) => item instanceof MessagePort ? wrapPort(item) : item))
    }
    this.#port.onmessageerror = (event: MessageEvent) => { this.emit('messageerror', event.data) }
    this.#syncActive()
  }

  postMessage (value: unknown, transferList: readonly unknown[] = []): void {
    const rawValue = mapOneLevel(value, toRaw)
    const rawTransfer = transferList.map(toRaw) as Transferable[]
    this.#port.postMessage(rawValue, rawTransfer)
  }

  ref (): this { this.#refd = true; this.#syncActive(); return this }
  unref (): this { this.#refd = false; this.#syncActive(); return this }
  hasRef (): boolean { return this.#refd }

  close (): void {
    if (this.#closed) return
    this.#closed = true
    this.#port.close()
    this.emit('close')
    if (this.#active) { this.#active = false; this.#onActive?.(false) }
  }

  /** The web MessagePort this wraps, unwrapped for a real postMessage's value or transfer list. */
  rawPort (): MessagePort { return this.#port }

  // Edge-triggered: on() calls this once directly and once through start(), and a caller's own
  // ref()/onActive is often a plain counter (runtime-thread.ts's liveness.ref()/unref()), which a
  // repeated call with the same value would double-count.
  #syncActive (): void {
    if (this.#closed) return
    const active = this.#refd && this.#started && (this.listenerCount('message') > 0 || this.listenerCount('messageerror') > 0)
    if (active === this.#active) return
    this.#active = active
    this.#onActive?.(active)
  }
}

/** The same wrapper every time for the same web port, so `postMessage`'s receiver sees identity-stable ports. */
export function wrapPort (port: MessagePort, onActive?: (active: boolean) => void): NodeMessagePort {
  let wrapper = wrappers.get(port)
  if (wrapper === undefined) {
    wrapper = new NodeMessagePort(port, INTERNAL, onActive)
    wrappers.set(port, wrapper)
  }
  return wrapper
}

export function createMessageChannel (): { port1: NodeMessagePort, port2: NodeMessagePort } {
  const channel = new MessageChannel()
  return { port1: wrapPort(channel.port1), port2: wrapPort(channel.port2) }
}

/** What a raw `postMessage` needs instead of a wrapped port found in a value: `workerData` and a `Worker`'s own transferList each cross this way. */
export function unwrapPorts (value: unknown): unknown {
  return mapOneLevel(value, toRaw)
}
