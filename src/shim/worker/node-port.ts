// Node's MessagePort shape over a web MessagePort: an `on('message', ...)`
// listener gets the value, not the event; `addEventListener('message', ...)`
// and the `onmessage`/`onmessageerror` attributes get a real `MessageEvent`,
// as Node's own does (measured); either form starts the port, matching
// MessagePort.start()'s own note that assigning `onmessage` does the same.
// The underlying port's own native 'close' -- which fires for either twin
// when the other one closes, not only the one `.close()` was called on
// (measured) -- becomes this wrapper's 'close'. A port arriving in a
// message, or passed in a transfer list, is wrapped or unwrapped one level
// into the value: its own top-level fields if it is a plain object or an
// array, never deeper, matching worker_threads.MessagePort's own shape (a
// port nested any deeper is carried as an opaque, unwrapped web MessagePort;
// worker/README.md's Design notes says why that stays a documented limit
// rather than a fix).
// Never patch MessagePort.prototype: every other module here keeps using
// the real one, and a wrapped port is a distinct object holding one.

import { EventEmitter } from 'events'

const INTERNAL = Symbol('orivon.node-message-port')
const wrappers = new WeakMap<MessagePort, NodeMessagePort>()
type DomListener = (event: Event | MessageEvent) => void

/** A `{}`-literal-shaped object, never a Date, Map, RegExp, port or other class instance: those clone (or transfer) as themselves, not as a record of ports to unwrap or wrap. */
function isPlainObject (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

/** Applies `convert` to `value` itself, then (only if unchanged) to an array or plain object's own top-level values. */
export function mapOneLevel (value: unknown, convert: (item: unknown) => unknown): unknown {
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
  readonly #domListeners = new Map<string, Map<DomListener, (...args: any[]) => void>>()
  #started = false
  #refd = true
  #closed = false
  #active = false
  #onmessageAttr: DomListener | null = null
  #onmessageerrorAttr: DomListener | null = null

  constructor (port: MessagePort, internal: symbol, onActive?: (active: boolean) => void) {
    if (internal !== INTERNAL) throw new TypeError('Illegal constructor')
    super()
    this.#port = port
    this.#onActive = onActive
    this.#port.addEventListener('close', () => { this.#onClosed() })
  }

  get onmessage (): DomListener | null { return this.#onmessageAttr }
  set onmessage (handler: DomListener | null) {
    if (this.#onmessageAttr !== null) this.removeEventListener('message', this.#onmessageAttr)
    this.#onmessageAttr = handler
    if (handler !== null) this.addEventListener('message', handler)
  }

  get onmessageerror (): DomListener | null { return this.#onmessageerrorAttr }
  set onmessageerror (handler: DomListener | null) {
    if (this.#onmessageerrorAttr !== null) this.removeEventListener('messageerror', this.#onmessageerrorAttr)
    this.#onmessageerrorAttr = handler
    if (handler !== null) this.addEventListener('messageerror', handler)
  }

  /** DOM-style listener, called with a real `Event`/`MessageEvent` (`.data` for 'message'/'messageerror'), as Node's own does; `on()` and its raw value are the other, EventEmitter-style form of the same events. */
  addEventListener (type: string, listener: DomListener): void {
    let byListener = this.#domListeners.get(type)
    if (byListener === undefined) { byListener = new Map(); this.#domListeners.set(type, byListener) }
    if (byListener.has(listener)) return
    const wrapped = type === 'message' || type === 'messageerror'
      ? (value: unknown) => { listener(new MessageEvent(type, { data: value })) }
      : () => { listener(new Event(type)) }
    byListener.set(listener, wrapped)
    this.on(type, wrapped)
  }

  removeEventListener (type: string, listener: DomListener): void {
    const wrapped = this.#domListeners.get(type)?.get(listener)
    if (wrapped === undefined) return
    this.#domListeners.get(type)?.delete(listener)
    this.removeListener(type, wrapped)
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

  override prependListener (event: string | symbol, listener: (...args: any[]) => void): this {
    super.prependListener(event, listener)
    if (event === 'message' || event === 'messageerror') this.start()
    this.#syncActive()
    return this
  }

  override prependOnceListener (event: string | symbol, listener: (...args: any[]) => void): this {
    super.prependOnceListener(event, listener)
    if (event === 'message' || event === 'messageerror') this.start()
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

  /** `transferList` also takes Node's `{ transfer: [...] }` form (measured), not only a bare array. */
  postMessage (value: unknown, transferListOrOptions: readonly unknown[] | { readonly transfer?: readonly unknown[] } = []): void {
    const list = (Array.isArray(transferListOrOptions) ? transferListOrOptions : (transferListOrOptions as { readonly transfer?: readonly unknown[] }).transfer) ?? []
    const rawValue = mapOneLevel(value, toRaw)
    const rawTransfer = list.map(toRaw) as Transferable[]
    this.#port.postMessage(rawValue, rawTransfer)
  }

  ref (): this { this.#refd = true; this.#syncActive(); return this }
  unref (): this { this.#refd = false; this.#syncActive(); return this }
  hasRef (): boolean { return this.#refd }

  close (): void {
    if (this.#closed) return
    this.#port.close()
    this.#onClosed()
  }

  /** Shared by `close()` and the underlying port's own native 'close' listener (constructor):
   * whichever runs first wins, so the other's guard makes it a no-op. */
  #onClosed (): void {
    if (this.#closed) return
    this.#closed = true
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

/** The other direction: a raw web `MessagePort` found in `value` one level deep, in Node's shape --
 * what `workerData` needs on the thread side, since only a `'message'` payload was wrapped before this. */
export function wrapPorts (value: unknown): unknown {
  return mapOneLevel(value, (item) => item instanceof MessagePort ? wrapPort(item) : item)
}
